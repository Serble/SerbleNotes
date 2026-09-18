//! Taking a mount point down.
//!
//! This exists as its own thing, rather than being left to `fuser`, because `fuser` cannot report
//! that an unmount failed. Built without libfuse, it mounts through `fusermount3` - which is setuid
//! and is how an ordinary user mounts and unmounts their own filesystem - and its unmount path is:
//!
//! ```text
//! if let Err(err) = libc_umount(...) {
//!     if err == EPERM {
//!         fuse_unmount_pure(&self.mountpoint);   // runs `fusermount3 -u`, ignores the result
//!         return Ok(());
//!     }
//! }
//! ```
//!
//! A non-root unmount always takes that branch, so `umount_and_join()` reports success whatever
//! `fusermount3` said and then blocks in `join()` waiting for a worker thread whose device is never
//! going to close. Anything still holding a file in the mount - an editor with it open, a shell
//! sitting in the directory - turns Ctrl-C into a hang with no explanation. Running the helper
//! ourselves is the whole difference: a refusal comes back as a refusal, with the sentence saying
//! which it was.

use std::path::Path;
use std::process::Command;

/// Unmounts, or says why not.
///
/// `detach` is `fusermount -z`: the mount point goes away now and the filesystem is released when
/// the last program holding a file in it lets go. It always succeeds and is never the first thing
/// tried, because anything still reading gets an error out of it.
pub fn unmount(mountpoint: &Path, detach: bool) -> Result<(), String> {
    let mut last = String::from("no fusermount helper on PATH");

    // `fusermount3` on anything current; `fusermount` is the FUSE 2 name, still what a few
    // distributions ship. Whichever one mounted this can unmount it.
    for helper in ["fusermount3", "fusermount"] {
        let mut command = Command::new(helper);
        command.arg("-u");
        if detach {
            command.arg("-z");
        }
        command.arg(mountpoint);

        let output = match command.output() {
            Ok(output) => output,
            Err(e) => {
                // Not this one. Try the other name before giving up.
                last = e.to_string();
                continue;
            }
        };

        if output.status.success() {
            return Ok(());
        }

        let said = String::from_utf8_lossy(&output.stderr).trim().to_string();

        // Already gone is the outcome that was wanted, however it happened - the user may have run
        // `fusermount -u` themselves, or the mount may have been taken down under us.
        let lower = said.to_lowercase();
        if lower.contains("not mounted") || lower.contains("not found in") {
            return Ok(());
        }

        return Err(if said.is_empty() {
            format!("{helper} exited with {}", output.status)
        } else {
            said
        });
    }

    Err(last)
}

/// How a mount point came down.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Unmounted {
    Cleanly,
    /// Detached while something still had a file open, because the user asked twice.
    Detached,
}

/// What [`take_down`] needs from the world.
///
/// A trait rather than the calls themselves, because the loop is the part that was wrong and the
/// loop is the part that cannot be reached from a test otherwise: it needs a busy mount point, a
/// second Ctrl-C and a wait, and none of those are things a test should have to arrange for real.
pub trait Unmounting {
    /// Try to unmount. `detach` is the `-z` form, which always succeeds and leaves anything still
    /// holding a file with an error.
    fn attempt(&mut self, detach: bool) -> Result<(), String>;

    /// Whether the user has asked, since the first attempt, to detach it anyway.
    fn detach_requested(&mut self) -> bool;

    /// Say why it did not happen. Called once, not on every retry.
    fn explain(&mut self, why: &str);

    /// Wait a moment before trying again.
    fn wait(&mut self);
}

/// Brings a mount point down without ever blocking on one that is in use.
///
/// The shape of it is the bug it exists to prevent. `fuser` reports a successful unmount whatever
/// `fusermount3` said, so a mount point something still had a file open in used to report success
/// and then hang forever in `join()`. Three things follow from that:
///
/// - the refusal has to be *reported*, not swallowed;
/// - the retry has to keep going, so closing the editor is enough on its own and the user does not
///   have to do anything else;
/// - and there has to be a way out that does not involve waiting for somebody else's program, which
///   is what a second Ctrl-C means.
pub fn take_down(world: &mut impl Unmounting) -> Result<Unmounted, String> {
    let mut explained = false;

    loop {
        match world.attempt(false) {
            Ok(()) => return Ok(Unmounted::Cleanly),
            Err(why) => {
                if !explained {
                    world.explain(&why);
                    explained = true;
                }

                if world.detach_requested() {
                    world.attempt(true)?;
                    return Ok(Unmounted::Detached);
                }

                world.wait();
            }
        }
    }
}

/// Checks a mount point before anything is mounted on it.
///
/// Refuses what cannot work and only warns about what merely looks odd: mounting over a directory
/// with something in it is legal, occasionally deliberate, and hides what is in it until the
/// unmount - so it is said rather than refused.
pub fn check(mountpoint: &Path, mkdir: bool) -> Result<(), String> {
    if mkdir && !mountpoint.exists() {
        std::fs::create_dir_all(mountpoint)
            .map_err(|e| format!("Could not create {}: {e}", mountpoint.display()))?;
    }

    let metadata = std::fs::metadata(mountpoint).map_err(|e| {
        format!(
            "{} cannot be used as a mount point: {e}. Make the directory first, or pass --mkdir.",
            mountpoint.display()
        )
    })?;

    if !metadata.is_dir() {
        return Err(format!("{} is not a directory.", mountpoint.display()));
    }

    if std::fs::read_dir(mountpoint)
        .map(|mut entries| entries.next().is_some())
        .unwrap_or(false)
    {
        log::warn!(
            "{} is not empty. Mounting over it hides what is in it until you unmount.",
            mountpoint.display()
        );
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A mount point that is busy for a while, and a user who may or may not ask again.
    struct Fake {
        /// How many normal attempts fail before one works.
        busy_for: usize,
        attempts: usize,
        detach_after: Option<usize>,
        detach_fails: bool,
        explained: Vec<String>,
        waits: usize,
    }

    impl Fake {
        fn new(busy_for: usize) -> Fake {
            Fake {
                busy_for,
                attempts: 0,
                detach_after: None,
                detach_fails: false,
                explained: Vec::new(),
                waits: 0,
            }
        }
    }

    impl Unmounting for Fake {
        fn attempt(&mut self, detach: bool) -> Result<(), String> {
            if detach {
                return if self.detach_fails {
                    Err("not permitted".into())
                } else {
                    Ok(())
                };
            }

            self.attempts += 1;
            if self.attempts <= self.busy_for {
                Err("Device or resource busy".into())
            } else {
                Ok(())
            }
        }

        fn detach_requested(&mut self) -> bool {
            matches!(self.detach_after, Some(after) if self.waits >= after)
        }

        fn explain(&mut self, why: &str) {
            self.explained.push(why.to_string());
        }

        fn wait(&mut self) {
            self.waits += 1;
        }
    }

    #[test]
    fn an_idle_mount_point_comes_down_at_once_and_says_nothing() {
        let mut world = Fake::new(0);
        assert_eq!(take_down(&mut world).unwrap(), Unmounted::Cleanly);
        assert_eq!(world.attempts, 1);
        assert!(world.explained.is_empty(), "nothing went wrong, so nothing to explain");
        assert_eq!(world.waits, 0);
    }

    #[test]
    fn a_busy_mount_point_is_retried_until_whatever_is_using_it_lets_go() {
        // The point of retrying: closing the editor has to be enough on its own. Before this, the
        // refusal was reported as a success and the caller blocked forever.
        let mut world = Fake::new(3);
        assert_eq!(take_down(&mut world).unwrap(), Unmounted::Cleanly);
        assert_eq!(world.attempts, 4);
        assert_eq!(world.waits, 3);
    }

    #[test]
    fn it_is_explained_once_and_not_on_every_retry() {
        let mut world = Fake::new(5);
        take_down(&mut world).unwrap();
        assert_eq!(world.explained.len(), 1, "a line every 300ms is not an explanation");
        assert!(world.explained[0].contains("busy"), "it has to say what it was told");
    }

    #[test]
    fn asking_again_detaches_it() {
        let mut world = Fake::new(usize::MAX);
        world.detach_after = Some(2);

        assert_eq!(take_down(&mut world).unwrap(), Unmounted::Detached);
        assert_eq!(world.waits, 2, "it detached at the first chance after being asked");
    }

    #[test]
    fn a_detach_that_fails_is_reported_rather_than_looping_forever() {
        let mut world = Fake::new(usize::MAX);
        world.detach_after = Some(1);
        world.detach_fails = true;

        assert!(take_down(&mut world).is_err());
    }

    #[test]
    fn it_never_detaches_something_that_was_not_busy() {
        // A detach leaves anything still holding a file with an error, so it is never the first
        // thing tried.
        struct Watchful(bool);
        impl Unmounting for Watchful {
            fn attempt(&mut self, detach: bool) -> Result<(), String> {
                assert!(!detach, "a clean unmount must not escalate");
                self.0 = true;
                Ok(())
            }
            fn detach_requested(&mut self) -> bool {
                panic!("nothing failed, so nothing should be asking about detaching")
            }
            fn explain(&mut self, _: &str) {
                panic!("nothing failed")
            }
            fn wait(&mut self) {
                panic!("nothing failed")
            }
        }

        let mut world = Watchful(false);
        assert_eq!(take_down(&mut world).unwrap(), Unmounted::Cleanly);
        assert!(world.0);
    }

    // --- the mount point itself -----------------------------------------------------------------

    fn scratch(name: &str) -> std::path::PathBuf {
        let path = std::env::temp_dir()
            .join(format!("serblenotes-check-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        let _ = std::fs::remove_file(&path);
        path
    }

    #[test]
    fn unmounting_something_that_is_not_mounted_is_success() {
        // The user may have run `fusermount -u` themselves, or the mount may have been taken down
        // under us. Either way the mount point is gone, which is what was being asked for - and
        // reporting it as a failure would send `take_down` into its retry loop forever.
        let path = scratch("notmounted");
        std::fs::create_dir_all(&path).unwrap();

        assert!(unmount(&path, false).is_ok(), "an ordinary directory is not mounted");
        assert!(unmount(&path, true).is_ok());
        let _ = std::fs::remove_dir_all(&path);
    }

    #[test]
    fn a_directory_that_is_there_is_fine() {
        let path = scratch("there");
        std::fs::create_dir_all(&path).unwrap();
        assert!(check(&path, false).is_ok());
        let _ = std::fs::remove_dir_all(&path);
    }

    #[test]
    fn a_directory_that_is_not_there_is_refused_unless_asked_for() {
        let path = scratch("missing");
        let refused = check(&path, false).unwrap_err();
        assert!(refused.contains("--mkdir"), "it has to say how to fix it: {refused}");

        assert!(check(&path, true).is_ok());
        assert!(path.is_dir());
        let _ = std::fs::remove_dir_all(&path);
    }

    #[test]
    fn a_file_is_not_a_mount_point() {
        let path = scratch("afile");
        std::fs::write(&path, "not a directory").unwrap();
        let refused = check(&path, true).unwrap_err();
        assert!(refused.contains("not a directory"), "{refused}");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_directory_with_something_in_it_is_allowed() {
        // Legal, occasionally deliberate, and their call. It is warned about, not refused.
        let path = scratch("full");
        std::fs::create_dir_all(&path).unwrap();
        std::fs::write(path.join("something"), "here").unwrap();
        assert!(check(&path, false).is_ok());
        let _ = std::fs::remove_dir_all(&path);
    }
}
