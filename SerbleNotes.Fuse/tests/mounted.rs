//! One test that mounts for real and uses the mount with ordinary shell commands.
//!
//! Everything else in `tests/mount.rs` drives the operations directly, which is the right way to
//! test them - but it cannot tell you that the mount comes up, that `readdir` hands the kernel
//! offsets it can resume from, or that `cat` and `mv` land where they are supposed to. This can,
//! and it is the only thing here that needs `/dev/fuse` and `fusermount3`.
//!
//! It skips rather than fails where they are not available, which is most build machines. A test
//! that cannot run is not a test that failed, and making CI need a kernel feature to go green would
//! only mean the suite stops being run.

mod support;

use std::path::Path;
use std::process::Command;

use serblenotes_fuse::fs::{Mount, VaultFs};
use serblenotes_fuse::mountpoint::unmount;
use support::{a_mount, shared, write_file, Setup};

fn can_mount() -> bool {
    if std::fs::OpenOptions::new().read(true).write(true).open("/dev/fuse").is_err() {
        return false;
    }
    ["/usr/bin/fusermount3", "/bin/fusermount3", "/usr/local/bin/fusermount3"]
        .iter()
        .any(|path| Path::new(path).exists())
}

fn sh(command: &str) -> (bool, String) {
    let output = Command::new("sh").arg("-c").arg(command).output().expect("sh");
    let mut text = String::from_utf8_lossy(&output.stdout).to_string();
    text.push_str(&String::from_utf8_lossy(&output.stderr));
    (output.status.success(), text)
}

/// A live mount that takes itself down whatever happens to the test holding it.
///
/// Cleaning up after the body, or inside a `catch_unwind`, is not enough: a test that panics part
/// way through, or one whose assertion fires while something still has a file open, leaves a real
/// mount on the developer's machine that outlives the test process. `Drop` runs either way, and it
/// escalates - a clean unmount first, then a detach - because the alternative is leaving one behind
/// and the point of a detach is that it always works.
struct Mounted {
    point: std::path::PathBuf,
    session: Option<fuser::BackgroundSession>,
}

impl Mounted {
    fn new(mount: Mount, read_only: bool) -> Mounted {
        // A plain counter, not the thread id: that formats with brackets, and a mount point with
        // brackets in it is one every shell command in these tests would have to quote.
        static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let point = std::env::temp_dir().join(format!(
            "serblenotes-live-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&point);
        std::fs::create_dir_all(&point).expect("mount point");

        let mut config = fuser::Config::default();
        config.mount_options = vec![fuser::MountOption::FSName("serblenotes-test".into())];
        if read_only {
            config.mount_options.push(fuser::MountOption::RO);
        }

        let session = fuser::spawn_mount(VaultFs::new(shared(mount)), &point, &config)
            .expect("could not mount");

        Mounted { point, session: Some(session) }
    }

    /// The mount point as a string, for the shell commands below.
    fn at(&self) -> String {
        self.point.display().to_string()
    }
}

impl Drop for Mounted {
    fn drop(&mut self) {
        let clean = unmount(&self.point, false).is_ok();
        if !clean {
            let _ = unmount(&self.point, true);
        }

        if let Some(session) = self.session.take() {
            if clean {
                let _ = session.umount_and_join();
            } else {
                // After a detach the worker can still be parked on a descriptor somebody else
                // holds; waiting for it is the hang this whole thing exists to avoid.
                std::mem::forget(session);
            }
        }

        let _ = std::fs::remove_dir(&self.point);
    }
}

/// A vault, mounted, with the body run against it.
fn mounted(prepare: impl FnOnce(&mut Mount), body: impl FnOnce(&str)) -> Setup {
    let (mut mount, setup) = a_mount();
    prepare(&mut mount);

    let live = Mounted::new(mount, false);
    body(&live.at());
    setup
}

#[test]
fn a_real_mount_behaves_like_a_folder_of_markdown_files() {
    if !can_mount() {
        eprintln!("skipping: this machine has no usable /dev/fuse or fusermount3");
        return;
    }

    let setup = mounted(
        |mount| {
            write_file(mount, "Work/Alpha.md", "# Alpha\n\nfirst\n").unwrap();
            write_file(mount, "Beta.md", "beta\n").unwrap();
        },
        |at| {
            let (ok, listing) = sh(&format!("ls -1 {at}"));
            assert!(ok, "ls failed: {listing}");
            assert_eq!(listing.lines().collect::<Vec<_>>(), vec!["Beta.md", "Work"]);

            let (ok, body) = sh(&format!("cat {at}/Work/Alpha.md"));
            assert!(ok, "cat failed: {body}");
            assert_eq!(body, "# Alpha\n\nfirst\n");

            // `ls -l` needs a size for every entry, and a wrong one truncates what tools read.
            let (ok, sizes) = sh(&format!("stat -c '%n %s' {at}/Beta.md"));
            assert!(ok, "stat failed: {sizes}");
            assert!(sizes.trim().ends_with(" 5"), "Beta.md is five bytes: {sizes}");

            // Writing through a shell redirect: open, truncate, write, close.
            let (ok, out) = sh(&format!("printf 'second\\n' > {at}/Work/Alpha.md"));
            assert!(ok, "write failed: {out}");
            let (_, body) = sh(&format!("cat {at}/Work/Alpha.md"));
            assert_eq!(body, "second\n");

            // A new note, and a folder to put it in.
            let (ok, out) = sh(&format!("mkdir {at}/Ideas && printf 'idea\\n' > {at}/Ideas/One.md"));
            assert!(ok, "mkdir/write failed: {out}");

            // A move, which is a rename of the note and nothing else.
            let (ok, out) = sh(&format!("mv {at}/Beta.md {at}/Ideas/Beta.md"));
            assert!(ok, "mv failed: {out}");
            let (_, listing) = sh(&format!("ls -1 {at}/Ideas"));
            assert_eq!(listing.lines().collect::<Vec<_>>(), vec!["Beta.md", "One.md"]);

            // An in-place edit, which is a temporary beside the file and a rename over the top.
            let (ok, out) = sh(&format!("sed -i 's/idea/edited/' {at}/Ideas/One.md"));
            assert!(ok, "sed -i failed: {out}");
            let (_, body) = sh(&format!("cat {at}/Ideas/One.md"));
            assert_eq!(body, "edited\n");

            // An editor that backs a file up by renaming it, then writes the new document at the
            // old name. Doing this for real is the point: it is what an editor did on a real vault,
            // and moving the note really left the name free, so the write below made a second note
            // and cut the history in half.
            let (ok, out) = sh(&format!(
                "cd {at} && mv Ideas/One.md Ideas/One.md~ && printf 'backed up\\n' > Ideas/One.md \
                 && rm Ideas/One.md~"
            ));
            assert!(ok, "backup-then-write failed: {out}");
            let (_, body) = sh(&format!("cat {at}/Ideas/One.md"));
            assert_eq!(body, "backed up\n");
            let (_, listing) = sh(&format!("ls -1 {at}/Ideas"));
            assert_eq!(listing.lines().collect::<Vec<_>>(), vec!["Beta.md", "One.md"]);

            // A file that is not markdown is kept here and never becomes a note.
            let (ok, out) = sh(&format!("printf 'x' > {at}/notes.txt"));
            assert!(ok, "writing a non-note file should work: {out}");
            let (_, body) = sh(&format!("cat {at}/notes.txt"));
            assert_eq!(body, "x");
        },
    );

    // What the server ended up holding, checked after the mount has gone away.
    let names: Vec<String> = setup
        .server
        .note_ids()
        .iter()
        .filter_map(|id| setup.server.note(id))
        .filter(|note| !note.deleted)
        .map(|note| serblenotes_core::open(&setup.key, &note.name).unwrap())
        .collect();

    let mut sorted = names.clone();
    sorted.sort();
    assert_eq!(sorted, vec!["Ideas/Beta", "Ideas/One", "Work/Alpha"]);

    let named = |want: &str| {
        setup
            .server
            .note_ids()
            .into_iter()
            .find(|id| {
                setup
                    .server
                    .note(id)
                    .map(|note| serblenotes_core::open(&setup.key, &note.name).unwrap() == want)
                    .unwrap_or(false)
            })
            .unwrap_or_else(|| panic!("{want}"))
    };

    // One save, one version. `Work/Alpha` was created and then written once through a shell
    // redirect, which opens the file, dups it and closes the original - so a flush arrives before
    // any byte does. Counting versions here is what caught that writing an empty one.
    assert_eq!(setup.server.version_count(&named("Work/Alpha")), 2, "created, then written once");

    // `Ideas/One` was created, edited by `sed -i`, and then saved again by an editor that renamed
    // it out of the way first. Three versions on one note, and no second note holding half of it.
    assert_eq!(setup.server.version_count(&named("Ideas/One")), 3, "one note, one history");
}

/// The bug that turned Ctrl-C into a hang, pinned where it actually happens.
///
/// `fuser` mounts through `fusermount3` when it is built without libfuse, and its unmount path
/// reports success whatever `fusermount3` said - so a mount point something still had a file open
/// in reported a clean unmount and then blocked forever in `join()`. Nothing below a real mount can
/// show that: it needs a real kernel, a real `fusermount3`, and a real open descriptor.
#[test]
fn a_busy_mount_point_refuses_to_unmount_rather_than_pretending() {
    if !can_mount() {
        return;
    }

    mounted(
        |mount| {
            write_file(mount, "Held.md", "open me\n").unwrap();
        },
        |at| {
            let point = Path::new(at);

            // Something holding a file, which is an editor with the note open.
            let held = std::fs::File::open(point.join("Held.md")).expect("open");

            let refused = unmount(point, false);
            assert!(
                refused.is_err(),
                "an unmount that could not happen must not come back as one that did - that is \
                 the difference between reporting it and hanging in join()"
            );

            // And it goes through once the file is let go, which is the whole reason `take_down`
            // retries instead of escalating: closing the editor has to be enough on its own.
            //
            // Not instantly, though, and that is worth being exact about. Dropping a descriptor on
            // a FUSE mount only starts the flush and release travelling to the filesystem, so an
            // unmount attempted in the same breath can still be told the mount is busy. A single
            // immediate assertion here failed about one run in three.
            drop(held);

            let freed = (0..100).any(|_| {
                if unmount(point, false).is_ok() {
                    return true;
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
                false
            });
            assert!(freed, "letting go of the file should have been enough within five seconds");
        },
    );
}

mod through_a_real_mount {
    use super::*;

    #[test]
    fn appending_to_a_note_keeps_what_was_there() {
        if !can_mount() {
            return;
        }

        let setup = mounted(
            |mount| {
                write_file(mount, "Log.md", "first\n").unwrap();
            },
            |at| {
                let (ok, out) = sh(&format!("printf 'second\\n' >> {at}/Log.md"));
                assert!(ok, "append failed: {out}");
                let (_, body) = sh(&format!("cat {at}/Log.md"));
                assert_eq!(body, "first\nsecond\n", "an append must not truncate");
            },
        );

        let note = setup.server.note_ids().into_iter().next().unwrap();
        assert_eq!(setup.server.version_count(&note), 2, "created, then appended once");
    }

    #[test]
    fn emptying_a_note_is_a_save_and_not_a_lost_edit() {
        if !can_mount() {
            return;
        }

        let setup = mounted(
            |mount| {
                write_file(mount, "Clear.md", "something\n").unwrap();
            },
            |at| {
                // `: >` truncates and writes nothing, so no `write` ever arrives - only `release`
                // is left to notice, which is why it saves unconditionally.
                let (ok, out) = sh(&format!(": > {at}/Clear.md"));
                assert!(ok, "truncate failed: {out}");
                let (_, body) = sh(&format!("cat {at}/Clear.md"));
                assert_eq!(body, "");
            },
        );

        let note = setup.server.note_ids().into_iter().next().unwrap();
        assert_eq!(setup.server.version_count(&note), 2, "emptying a note is an edit to it");
    }

    #[test]
    fn a_note_larger_than_one_read_comes_back_whole() {
        if !can_mount() {
            return;
        }

        // The kernel reads in pages, so anything that got an offset or a length wrong would show up
        // as a note that is right for the first 4 KiB and wrong after it.
        let big: String = (0..5000).map(|i| format!("line {i}\n")).collect();
        let expected = big.clone();

        mounted(
            move |mount| {
                write_file(mount, "Big.md", &big).unwrap();
            },
            move |at| {
                let (ok, body) = sh(&format!("cat {at}/Big.md"));
                assert!(ok);
                assert_eq!(body.len(), expected.len(), "read back a different length");
                assert_eq!(body, expected);

                // And the size the kernel reports has to agree, or anything trusting it truncates.
                let (_, stat) = sh(&format!("stat -c '%s' {at}/Big.md"));
                assert_eq!(stat.trim(), expected.len().to_string());

                // Reading from the middle, which is what an editor jumping around does.
                let (_, tail) = sh(&format!("tail -c 20 {at}/Big.md"));
                assert_eq!(tail, expected[expected.len() - 20..]);
            },
        );
    }

    #[test]
    fn a_note_written_larger_than_one_write_arrives_whole() {
        if !can_mount() {
            return;
        }

        let setup = mounted(
            |_| {},
            |at| {
                let (ok, out) = sh(&format!(
                    "seq 1 20000 | sed 's/$/ a line of some length/' > {at}/Written.md"
                ));
                assert!(ok, "write failed: {out}");
                let (_, lines) = sh(&format!("wc -l < {at}/Written.md"));
                assert_eq!(lines.trim(), "20000");
            },
        );

        let note = setup.server.note_ids().into_iter().next().unwrap();
        assert_eq!(
            setup.server.version_count(&note),
            1,
            "one save, however many writes the kernel split it into"
        );
    }

    #[test]
    fn copying_a_note_inside_the_mount_makes_a_second_note() {
        if !can_mount() {
            return;
        }

        let setup = mounted(
            |mount| {
                write_file(mount, "Original.md", "the text\n").unwrap();
            },
            |at| {
                let (ok, out) = sh(&format!("cp {at}/Original.md {at}/Copy.md"));
                assert!(ok, "cp failed: {out}");
                let (_, body) = sh(&format!("cat {at}/Copy.md"));
                assert_eq!(body, "the text\n");
            },
        );

        assert_eq!(setup.server.note_ids().len(), 2);
    }

    #[test]
    fn a_deep_folder_can_be_made_and_taken_apart_again() {
        if !can_mount() {
            return;
        }

        mounted(
            |_| {},
            |at| {
                let (ok, out) = sh(&format!("mkdir -p {at}/a/b/c"));
                assert!(ok, "mkdir -p failed: {out}");
                assert!(sh(&format!("test -d {at}/a/b/c")).0);

                let (ok, out) = sh(&format!("printf 'deep\\n' > {at}/a/b/c/Note.md"));
                assert!(ok, "{out}");

                // A folder with something under it is not empty, at any depth.
                assert!(!sh(&format!("rmdir {at}/a/b/c")).0);
                assert!(!sh(&format!("rmdir {at}/a")).0);

                assert!(sh(&format!("rm {at}/a/b/c/Note.md")).0);
                assert!(sh(&format!("rmdir {at}/a/b/c && rmdir {at}/a/b && rmdir {at}/a")).0);
                assert!(!sh(&format!("test -d {at}/a")).0);
            },
        );
    }

    #[test]
    fn moving_a_folder_takes_its_notes_with_it() {
        if !can_mount() {
            return;
        }

        let setup = mounted(
            |mount| {
                write_file(mount, "Work/One.md", "one\n").unwrap();
                write_file(mount, "Work/Deep/Two.md", "two\n").unwrap();
            },
            |at| {
                let (ok, out) = sh(&format!("mv {at}/Work {at}/Archive"));
                assert!(ok, "mv of a folder failed: {out}");

                let (_, one) = sh(&format!("cat {at}/Archive/One.md"));
                assert_eq!(one, "one\n");
                let (_, two) = sh(&format!("cat {at}/Archive/Deep/Two.md"));
                assert_eq!(two, "two\n");
                assert!(!sh(&format!("test -e {at}/Work")).0);
            },
        );

        // A move is metadata, so neither note gained a version.
        for note in setup.server.note_ids() {
            assert_eq!(setup.server.version_count(&note), 1);
        }
    }

    #[test]
    fn a_note_read_while_it_is_being_written_is_never_half_a_note() {
        if !can_mount() {
            return;
        }

        mounted(
            |mount| {
                write_file(mount, "Shared.md", "before\n").unwrap();
            },
            |at| {
                // Several readers at once, while a writer replaces it. Every read has to see one
                // whole version or the other, never a mixture.
                let (ok, out) = sh(&format!(
                    "for i in $(seq 1 20); do cat {at}/Shared.md > /dev/null & done; \
                     printf 'after\\n' > {at}/Shared.md; wait"
                ));
                assert!(ok, "{out}");

                let (_, body) = sh(&format!("cat {at}/Shared.md"));
                assert!(body == "before\n" || body == "after\n", "got a mixture: {body:?}");
            },
        );
    }

    #[test]
    fn what_a_vault_holds_survives_being_walked_by_ordinary_tools() {
        if !can_mount() {
            return;
        }

        mounted(
            |mount| {
                write_file(mount, "Top.md", "top\n").unwrap();
                write_file(mount, "Work/Inner.md", "inner\n").unwrap();
                mount.mkdir_at("Empty").unwrap();
            },
            |at| {
                // `find` stats everything, which is the path that has to rebuild every note.
                let (ok, found) = sh(&format!("find {at} -type f -name '*.md' | sort"));
                assert!(ok, "{found}");
                assert_eq!(
                    found.lines().map(|l| l.replace(at, "")).collect::<Vec<_>>(),
                    vec!["/Top.md", "/Work/Inner.md"]
                );

                let (ok, dirs) = sh(&format!("find {at} -type d | sort"));
                assert!(ok, "{dirs}");
                assert_eq!(dirs.lines().count(), 3, "the root, Work and Empty: {dirs}");

                // `du` adds the sizes up, and `grep -r` reads every byte of every one.
                assert!(sh(&format!("du -s {at}")).0);
                let (ok, hits) = sh(&format!("grep -rl inner {at}"));
                assert!(ok, "grep -r found nothing: {hits}");
                assert!(hits.contains("Inner.md"));
            },
        );
    }

    #[test]
    fn a_symlink_is_refused_without_taking_the_mount_down_with_it() {
        if !can_mount() {
            return;
        }

        mounted(
            |mount| {
                write_file(mount, "Real.md", "real\n").unwrap();
            },
            |at| {
                // Emacs makes one of these as a lock file and carries on when it cannot.
                assert!(!sh(&format!("ln -s Real.md {at}/Link.md")).0);
                assert!(!sh(&format!("ln {at}/Real.md {at}/Hard.md")).0);

                // And the mount is still perfectly usable afterwards.
                let (_, body) = sh(&format!("cat {at}/Real.md"));
                assert_eq!(body, "real\n");
            },
        );
    }

    #[test]
    fn a_missing_file_is_missing_rather_than_empty() {
        if !can_mount() {
            return;
        }

        mounted(
            |_| {},
            |at| {
                let (ok, said) = sh(&format!("cat {at}/NotThere.md"));
                assert!(!ok);
                assert!(said.contains("No such file"), "{said}");
                assert!(!sh(&format!("test -e {at}/NotThere.md")).0);
            },
        );
    }

    #[test]
    fn a_read_only_mount_refuses_writes_at_the_kernel_rather_than_only_in_this_process() {
        if !can_mount() {
            return;
        }

        let (mut mount, setup) = a_mount();
        write_file(&mut mount, "Fixed.md", "as it was\n").unwrap();
        mount.read_only = true;

        {
            let live = Mounted::new(mount, true);
            let at = live.at();

            let (_, body) = sh(&format!("cat {at}/Fixed.md"));
            assert_eq!(body, "as it was\n", "read-only still means readable");

            assert!(!sh(&format!("printf 'no\\n' > {at}/Fixed.md")).0);
            assert!(!sh(&format!("printf 'no\\n' > {at}/New.md")).0);
            assert!(!sh(&format!("rm {at}/Fixed.md")).0);
            assert!(!sh(&format!("mkdir {at}/Folder")).0);
        }

        assert_eq!(setup.server.note_ids().len(), 1);
        let note = setup.server.note_ids().into_iter().next().unwrap();
        assert_eq!(setup.server.version_count(&note), 1, "nothing got through");
    }
}
