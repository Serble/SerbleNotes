//! Keeping the mount and the server in step.
//!
//! One background thread, doing four things on a timer:
//!
//! 1. **Warming.** Every note's body is fetched once, quietly, after the mount comes up. Nothing
//!    depends on this having happened - every read fetches what it needs - but `ls -l` has to know
//!    how long each note is, and the only way to know is to rebuild it. Doing that in the
//!    background is the difference between a mount that lists instantly and one that downloads the
//!    vault the first time anybody looks at it.
//! 2. **Pulling.** `/changes` from this device's cursor, metadata only, which is the same read path
//!    the web client uses. Polling rather than the sync socket: a delta that finds nothing is a few
//!    hundred bytes, and a socket brings a ping timer, a backoff and a reconnect path that would
//!    all have to be right before the first note could be read.
//! 3. **Reconciling.** A note that changed on another device while this one was holding unsaved
//!    text is a fork, and the answer is a three-way merge - never a winner.
//! 4. **Retrying.** Anything the server would not take, including edits carried over from a
//!    previous mount.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use crate::fs::{Mount, OpenNote};
use crate::names::file_path_for;
use crate::tree::Entry;

fn lock(mount: &Arc<Mutex<Mount>>) -> std::sync::MutexGuard<'_, Mount> {
    mount.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Brings back edits this device was holding when it last stopped.
///
/// They are put back exactly where they were - an open buffer for a note that exists, a file in
/// the mount for a note that was never created - and marked unsent, so the first pass of the loop
/// reconciles and sends them. Called before the filesystem is mounted, so nothing can read a note
/// without the edit that belongs to it.
pub fn restore_unsent(mount: &Arc<Mutex<Mount>>) -> usize {
    let mut mount = lock(mount);
    let edits = mount.store.take_unsent();
    let mut restored = 0;

    for edit in edits {
        match &edit.note_id {
            // A tombstone is still a row, and that is the trap here: the note *exists* as far as
            // this check is concerned, so the edit went back into a buffer for it - and `save_note`
            // refuses to write to a deleted note, so it could never be sent and could never be
            // seen, because the tree is drawn from the live notes. Stranded, silently, forever.
            Some(note_id)
                if mount.store.get_note(note_id).is_some_and(|note| !note.deleted) =>
            {
                mount.open_notes.insert(
                    note_id.clone(),
                    OpenNote {
                        data: edit.text.into_bytes(),
                        dirty: true,
                        // It was written, in a previous session. If the user opens and closes the
                        // file before the sync loop gets to it, that close should still save it.
                        written: true,
                        baseline: edit.baseline,
                        merge_parent: None,
                    },
                );
            }
            // The note is gone from this device's copy of the vault - deleted elsewhere, or this
            // cache is simply older than the edit - or it was never created at all. Either way the
            // text is the only copy there is, so it comes back as a file rather than being dropped.
            _ => restore_as_file(&mut mount, &edit.name, &edit.text),
        }
        restored += 1;
    }

    restored
}

fn restore_as_file(mount: &mut Mount, note_name: &str, text: &str) {
    let Ok(path) = file_path_for(note_name) else {
        return;
    };
    mount.add_local(&path, text.as_bytes());
}

/// Starts the loop. Dropping the returned handle does not stop it; set `stop` and join.
///
/// Warming runs on a thread of its own rather than before the loop, and that is not tidiness. It is
/// one request per note - a few hundred on a real vault, each a round trip to a server that may be
/// on the other side of the country - and while it was happening no poll ran at all. On a fast
/// server that is a second; on a slow one it is minutes of a mount that quietly does not notice
/// anything anybody else does. The two share the mount's lock, so they interleave a request at a
/// time rather than racing.
pub fn spawn(
    mount: Arc<Mutex<Mount>>,
    interval: Duration,
    stop: Arc<AtomicBool>,
) -> JoinHandle<()> {
    let warming = {
        let mount = Arc::clone(&mount);
        let stop = Arc::clone(&stop);
        std::thread::spawn(move || warm(&mount, &stop))
    };

    std::thread::spawn(move || {
        // One pass immediately, so a mount that came up from cache catches up with the server
        // before anybody has had time to open anything.
        tick(&mount);

        while !stop.load(Ordering::Relaxed) {
            if !nap(&stop, interval) {
                break;
            }
            tick(&mount);
        }

        // `warm` checks between notes, so this is at most one request long.
        let _ = warming.join();
    })
}

/// Sleeps in short steps so unmounting does not have to wait out a whole interval.
///
/// Returns whether the wait finished, as against being cut short by a stop. The difference is the
/// whole point: a loop that carried on after being told to stop would keep polling a vault that is
/// being unmounted, and one that never finished the wait would never poll at all.
pub fn nap(stop: &Arc<AtomicBool>, interval: Duration) -> bool {
    let step = Duration::from_millis(200);
    let mut left = interval;

    while left > Duration::ZERO {
        if stop.load(Ordering::Relaxed) {
            return false;
        }
        let this = step.min(left);
        std::thread::sleep(this);
        left -= this;
    }

    true
}

/// Fetches every note's body once, one note at a time.
///
/// The lock is taken and released per note rather than held for the whole walk: a vault of a few
/// hundred notes is a few hundred round trips, and holding the mount still for all of them would
/// mean the first `ls` after mounting hanging until the download finished.
fn warm(mount: &Arc<Mutex<Mount>>, stop: &Arc<AtomicBool>) {
    let note_ids = lock(mount).store.note_ids();

    for note_id in note_ids {
        if stop.load(Ordering::Relaxed) {
            return;
        }

        let mut guard = lock(mount);
        if guard.store.is_readable(&note_id) {
            continue;
        }
        if let Err(error) = guard.store.ensure_note(&note_id) {
            // Nothing is broken by this. The note is fetched when it is read, and that read will
            // report the same problem to whoever asked for it.
            log::debug!("could not fetch {note_id} in the background: {error}");
            if error.is_offline() {
                return;
            }
        }
    }
}

/// One pass: pull, reconcile, send.
///
/// The order is the whole point, and it is the same order `noteSync.resync` uses. A device that has
/// been out of touch missed the changes it would have been told about, so it has to pull before it
/// can know what it is building on. Saving first is what turns every reconnect into a fork.
pub fn tick(mount: &Arc<Mutex<Mount>>) {
    let mut guard = lock(mount);

    match guard.store.pull() {
        Ok(pulled) => {
            for note_id in &pulled.moved {
                reconcile(&mut guard, note_id);
            }
        }
        Err(error) if error.is_offline() => {
            // Expected, repeatedly, on a laptop. Nothing to say about it every ten seconds.
            log::debug!("not reaching the server this time: {error}");
        }
        Err(error) => log::warn!("could not pull changes: {error}"),
    }

    send_unsent(&mut guard);
}

/// Brings one note's buffer into line with what the server now has.
///
/// There are three cases, not two, and the difference between the second and the third is the one
/// thing here that can silently destroy an edit:
///
/// - **The new head descends from ours and we have nothing unsent.** It contains everything our
///   baseline contained, so it can be taken as it is: the buffer is dropped and the next read
///   rebuilds from the new head. A reader sees the other device's text, which is what a shared
///   filesystem is for.
/// - **The new head is a sibling.** Both devices built on the same parent, so neither branch
///   contains the other and there is nothing to fast-forward *to*. Adopting either makes the other
///   device's work vanish from the file. This is a fork **whether or not anything is unsent** - our
///   own saved version is a branch the other side has never seen either - and the only answer that
///   keeps both is a three-way merge.
/// - **We have something unsent.** A merge again, for the same reason.
///
/// An unmergeable hunk becomes conflict markers in the file, for the user to resolve in whatever
/// editor they already have it open in. Nothing here ever picks a side.
fn reconcile(mount: &mut Mount, note_id: &str) {
    let Some(open) = mount.open_notes.get(note_id) else {
        return;
    };
    let base = open.baseline.clone();
    let dirty = open.dirty;

    let Some(remote_head) = mount.store.head_of(note_id) else {
        return;
    };
    if base.as_deref() == Some(remote_head.as_str()) {
        return;
    }

    // No baseline at all means this buffer is not holding a version to lose.
    let Some(base) = base else {
        mount.open_notes.remove(note_id);
        return;
    };

    if !dirty && mount.store.descends_from(&remote_head, &base) {
        mount.open_notes.remove(note_id);
        return;
    }

    // Two chains, named rather than fetched as "the whole note": the head that arrived, and the
    // version this buffer has been working from.
    if let Err(error) = mount
        .store
        .ensure_versions(&[Some(remote_head.clone()), Some(base.clone())])
    {
        log::warn!("could not merge {note_id}: {error}");
        return;
    }

    // Where the two branches diverged. It can be far enough back to share no chain with either.
    let ancestor = mount.store.common_ancestor(&base, &remote_head);
    if let Err(error) = mount.store.ensure_versions(std::slice::from_ref(&ancestor)) {
        log::warn!("could not merge {note_id}: {error}");
        return;
    }

    let remote_text = match mount.store.materialise(&remote_head) {
        Ok(text) => text,
        Err(error) => {
            log::warn!("could not read the newer version of {note_id}: {error}");
            return;
        }
    };

    let base_text = match mount.store.materialise(&base) {
        Ok(text) => text,
        Err(error) => {
            log::warn!("could not read the version {note_id} was edited from: {error}");
            return;
        }
    };

    let ancestor_text = match &ancestor {
        Some(ancestor) => match mount.store.materialise(ancestor) {
            Ok(text) => text,
            // A history that cannot be walked back to the fork point. Merging against our own base
            // is the closest honest thing: it treats our side as unchanged since then rather than
            // inventing an ancestor, and the worst it can do is report a conflict.
            Err(_) => base_text,
        },
        None => base_text,
    };

    let Some(open) = mount.open_notes.get(note_id) else {
        return;
    };
    let Ok(ours) = String::from_utf8(open.data.clone()) else {
        return;
    };

    let (merged, conflicted) = mount.store.merge(&ancestor_text, &ours, &remote_text);

    if conflicted {
        let what = mount
            .store
            .path_of(note_id)
            .unwrap_or_else(|| note_id.to_string());
        log::warn!(
            "{what} was edited here and on another device at the same time. Both edits are in the \
             file, separated by conflict markers, for you to resolve."
        );
    }

    if let Some(open) = mount.open_notes.get_mut(note_id) {
        open.data = merged.into_bytes();
        // The branch we came from, so the version written next records both sides of the fork and
        // the note stops being seen as forked.
        open.merge_parent = Some(base);
        open.baseline = Some(remote_head);
        open.dirty = true;
    }
}

/// Sends everything the server has not taken, and reconciles first if the note moved underneath it.
fn send_unsent(mount: &mut Mount) {
    let dirty: Vec<String> = mount
        .open_notes
        .iter()
        .filter(|(_, open)| open.dirty)
        .map(|(note_id, _)| note_id.clone())
        .collect();

    for note_id in dirty {
        // An edit carried over from a previous mount has a baseline that may be several versions
        // behind, and `save_note` would diff straight from the current head - which is exactly how
        // a restored edit silently undoes what another device did in the meantime.
        let stale = mount
            .open_notes
            .get(&note_id)
            .is_some_and(|open| open.baseline != mount.store.head_of(&note_id));
        if stale {
            reconcile(mount, &note_id);
        }

        let ino = mount.inodes.number(Entry::Note(note_id));
        let _ = mount.commit(ino);
    }

    let pending: Vec<u64> = mount
        .locals
        .iter()
        .filter(|(_, file)| mount.is_note_path(&file.path))
        .map(|(id, _)| *id)
        .collect();

    for id in pending {
        let ino = mount.inodes.number(Entry::Local(id));
        let _ = mount.commit(ino);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    #[test]
    fn a_wait_that_runs_its_course_says_so() {
        let stop = Arc::new(AtomicBool::new(false));
        assert!(nap(&stop, Duration::from_millis(50)));
    }

    #[test]
    fn a_wait_actually_waits() {
        // A nap that returned immediately would turn the poll into a busy loop against the server.
        let stop = Arc::new(AtomicBool::new(false));
        let started = Instant::now();
        nap(&stop, Duration::from_millis(300));
        assert!(started.elapsed() >= Duration::from_millis(250), "{:?}", started.elapsed());
    }

    #[test]
    fn being_told_to_stop_cuts_the_wait_short() {
        let stop = Arc::new(AtomicBool::new(true));
        let started = Instant::now();

        assert!(!nap(&stop, Duration::from_secs(60)));
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "unmounting must not have to sit out a whole interval: {:?}",
            started.elapsed()
        );
    }

    #[test]
    fn a_stop_part_way_through_is_noticed_without_waiting_for_the_end() {
        let stop = Arc::new(AtomicBool::new(false));
        let raise = Arc::clone(&stop);
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(100));
            raise.store(true, Ordering::Relaxed);
        });

        let started = Instant::now();
        assert!(!nap(&stop, Duration::from_secs(30)));
        assert!(started.elapsed() < Duration::from_secs(2), "{:?}", started.elapsed());
    }
}
