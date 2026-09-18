//! `serblenotes-fuse` - mounts a Serble Notes vault as a directory of markdown files, so a vault
//! can be edited with whatever editor the user already has.
//!
//! The shape of it: `login` once per machine, `mount` per vault. A mounted vault is a folder of
//! `.md` files with real directories for the folders - the same layout an exported zip has, and for
//! the same reason - and every time a file is closed after being written to, that write becomes a
//! new version in the note's history.
//!
//! **Nothing here ever has to be typed.** Every value this program reads from a terminal - the
//! server, the session, the sign-in code, the vault password - has a flag and an environment
//! variable that supply it instead, so a mount can be brought up by a script, a unit file or a
//! container with no interactive input at all. The prompts exist for people, not as the only way in.
//!
//! Nothing here decrypts, diffs or merges anything. All of that is the Rust core, which this links
//! natively and the browser loads as WASM, so the filesystem and the app can never disagree about
//! what a stored version means.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use clap::{Parser, Subcommand};
use fuser::{MountOption, SessionACL};

use serblenotes_fuse::api::{self, ApiError, HttpBackend, Vault};
use serblenotes_fuse::cache::VaultCache;
use serblenotes_fuse::config::{KeyStore, Settings};
use serblenotes_fuse::fs::{Mount, VaultFs};
use serblenotes_fuse::mountpoint::{self, unmount, Unmounted, Unmounting};
use serblenotes_fuse::names::Ignore;
use serblenotes_fuse::store::VaultStore;
use serblenotes_fuse::unlock::{password_source, PasswordSource};
use serblenotes_fuse::{login, sync, unlock, vaults};

#[derive(Parser)]
#[command(
    name = "serblenotes-fuse",
    about = "Mount a Serble Notes vault as a folder of markdown files",
    version,
    after_help = "Every prompt has a flag, so nothing has to be typed:\n  \
                  --server / SERBLENOTES_SERVER          which deployment\n  \
                  --token / SERBLENOTES_TOKEN            the session, instead of `login`\n  \
                  login --code                           a sign-in code, instead of a browser\n  \
                  mount --password / --password-stdin / SERBLENOTES_VAULT_PASSWORD\n\n\
                  Files an editor makes for itself never become notes. `mount --ignore <GLOB>`,\n\
                  repeatable, adds to that list."
)]
struct Cli {
    #[command(subcommand)]
    command: Command,

    /// The Serble Notes server. Defaults to the one this copy was built for, and `login` remembers
    /// whatever is given here.
    #[arg(long, global = true, value_name = "URL")]
    server: Option<String>,

    /// Use this session token for one command, instead of the one `login` saved. This is the whole
    /// of what a script needs to skip signing in.
    #[arg(long, global = true, value_name = "JWT")]
    token: Option<String>,

    /// Say nothing that is not a problem.
    #[arg(long, short, global = true)]
    quiet: bool,
}

#[derive(Subcommand)]
enum Command {
    /// Sign in to Serble and remember this machine's session.
    Login {
        /// Print the sign-in address instead of opening a browser, and read the address it lands on
        /// back from the terminal. This is the one to use over SSH.
        #[arg(long)]
        no_browser: bool,

        /// A sign-in code obtained some other way. Skips the browser and the terminal entirely,
        /// which is what a script wants; with it, this command reads nothing.
        #[arg(long, value_name = "CODE")]
        code: Option<String>,
    },

    /// Forget this machine's session. Vault keys are left alone - see `forget` for those.
    Logout,

    /// Show which account this machine is signed in as.
    Whoami,

    /// List the vaults on this account.
    Vaults,

    /// Mount a vault. Runs in the foreground until interrupted.
    Mount {
        /// Vault id, or its name if that names exactly one.
        vault: String,

        /// Where to mount it.
        mountpoint: PathBuf,

        /// The vault password.
        ///
        /// Convenient and not private: anything on a command line can be read by anyone who can
        /// list processes on this machine, and it is usually kept in the shell's history.
        /// --password-stdin and SERBLENOTES_VAULT_PASSWORD do the same job without that.
        #[arg(long, value_name = "PASSWORD")]
        password: Option<String>,

        /// Read the vault password from standard input.
        #[arg(long, conflicts_with = "password")]
        password_stdin: bool,

        /// Do not write the unlocked vault key to this machine. The password is then needed for
        /// every mount.
        #[arg(long)]
        no_remember: bool,

        /// Create the mount point if it does not exist.
        #[arg(long)]
        mkdir: bool,

        /// Leave files matching this alone: they live in the mount and never become notes.
        ///
        /// Repeat it for more than one. A pattern with no `/` matches the file's own name wherever
        /// it is (`*.bak`); one with a `/` matches the whole path from the root of the mount
        /// (`Drafts/*`, `Drafts/**`), and `*` stops at a `/` as it does in a `.gitignore`. The
        /// editors whose working files are a known shape - swap files, backups, the temporary an
        /// atomic save renames into place - are already handled without this.
        #[arg(long, value_name = "GLOB")]
        ignore: Vec<String>,

        /// Seconds between checks for changes made on your other devices.
        #[arg(long, default_value_t = 10, value_name = "SECONDS")]
        interval: u64,

        /// Mount without the ability to write. Nothing in the vault can be changed through it.
        #[arg(long)]
        read_only: bool,

        /// Let other users on this machine read the mount. Off by default, and it means what it
        /// says: anybody on the machine can read every note in the vault.
        #[arg(long)]
        allow_other: bool,
    },

    /// Drop this machine's copy of a vault's key, and optionally its cached copy of the vault.
    Forget {
        /// Vault id, or its name.
        vault: String,

        /// Also delete this machine's cached ciphertext for the vault. Unsent edits go with it.
        #[arg(long)]
        cache: bool,
    },
}

fn main() {
    // `fuser` logs a warning every time the kernel asks for something this filesystem does not
    // implement - `copy_file_range`, ioctls, locks - and the kernel asks constantly, falling back
    // perfectly well each time. None of it is a problem the user can act on, so it is quiet unless
    // they ask for it; everything this program has to say about their notes is its own.
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info,fuser=error"))
        .format_timestamp(None)
        .format_target(false)
        .init();

    if let Err(message) = run(Cli::parse()) {
        eprintln!("{message}");
        std::process::exit(1);
    }
}

fn run(cli: Cli) -> Result<(), String> {
    let mut session = Session::resolve(&cli);

    match cli.command {
        Command::Login { no_browser, code } => login_command(&mut session, no_browser, code),
        Command::Logout => logout_command(&session),
        Command::Whoami => whoami_command(&session),
        Command::Vaults => vaults_command(&session),
        Command::Mount {
            vault,
            mountpoint,
            password,
            password_stdin,
            no_remember,
            mkdir,
            ignore,
            interval,
            read_only,
            allow_other,
        } => mount_command(
            &session,
            &vault,
            &mountpoint,
            Password {
                given: password,
                from_stdin: password_stdin,
                remember: !no_remember,
            },
            MountOptions {
                mkdir,
                ignore,
                interval,
                read_only,
                allow_other,
            },
        ),
        Command::Forget { vault, cache } => forget_command(&session, &vault, cache),
    }
}

/// Where this run is pointed and who it is, once the flags, the environment and the saved session
/// have been resolved against each other.
///
/// The order is the same for both: what this command was told, then what the environment says, then
/// what was saved, then - for the server, which always has an answer - what this copy was built
/// for. Resolved once, here, so no command can work it out differently.
struct Session {
    settings: Settings,
    server: String,
    /// Set when the server was named by this run rather than merely remembered, which is what
    /// decides whether `login` writes it down.
    server_was_given: bool,
    token: Option<String>,
    device_id: String,
    quiet: bool,
}

impl Session {
    fn resolve(cli: &Cli) -> Session {
        let mut settings = Settings::load();
        let device_id = settings.device_id();

        let chosen = settings.choose_server(cli.server.as_deref());

        let token = settings.choose_token(cli.token.as_deref());

        Session {
            token,
            settings,
            server: chosen.url,
            server_was_given: chosen.given,
            device_id,
            quiet: cli.quiet,
        }
    }

    /// A client with no session, for the one route that works without one.
    fn anonymous(&self) -> HttpBackend {
        HttpBackend::new(&self.server, None, self.device_id.clone())
    }

    /// A client carrying this run's session, or a sentence saying there is not one.
    fn backend(&self) -> Result<HttpBackend, String> {
        let token = self.token.clone().ok_or_else(|| {
            format!(
                "Not signed in to {}. Run `serblenotes-fuse login`, or pass --token.",
                self.server
            )
        })?;

        Ok(HttpBackend::new(&self.server, Some(token), self.device_id.clone()))
    }

    /// The vault a command names, looked up on the server.
    fn vault(&self, wanted: &str) -> Result<Vault, String> {
        let vaults = self
            .backend()?
            .list_vaults()
            .map_err(|e| api::describe(&e, &self.server))?;
        vaults::find(&vaults, wanted)
    }

    /// Turns a failure into the sentence this run should print for it.
    fn explain(&self, error: ApiError) -> String {
        api::describe(&error, &self.server)
    }

    /// Something worth saying to a person, which a script does not need.
    fn say(&self, line: impl AsRef<str>) {
        if !self.quiet {
            println!("{}", line.as_ref());
        }
    }
}

/// Everywhere a vault password can come from, in the order they are tried.
struct Password {
    given: Option<String>,
    from_stdin: bool,
    remember: bool,
}

struct MountOptions {
    mkdir: bool,
    ignore: Vec<String>,
    interval: u64,
    read_only: bool,
    allow_other: bool,
}

// --- session ------------------------------------------------------------------------------------

fn login_command(session: &mut Session, no_browser: bool, given_code: Option<String>) -> Result<(), String> {
    let anonymous = session.anonymous();

    let code = match given_code {
        // A code from somewhere else. Nothing is read and nothing is opened - the whole point of
        // it - so there is no state of ours for it to match, and the server refusing a code that
        // was never issued is the check that remains.
        Some(code) => code,
        None => {
            let config = anonymous
                .client_config()
                .map_err(|e| format!("Could not read {}/api/config: {e}", session.server))?;
            if config.serble_app_id.is_empty() {
                return Err(format!(
                    "{} has no Serble application id configured, so there is nothing to sign in to.",
                    session.server
                ));
            }

            let state = login::new_state();
            let url = login::authorize_url(&config.serble_app_id, &state);

            if no_browser {
                println!("Open this in a browser:\n\n  {url}\n");
                println!(
                    "It will finish at {}, which will not load unless you are on this machine.\n\
                     Copy the whole address out of the address bar and paste it here:",
                    login::redirect_uri()
                );

                let mut line = String::new();
                std::io::stdin()
                    .read_line(&mut line)
                    .map_err(|e| format!("Could not read that: {e}"))?;
                login::code_from(line.trim(), &state)?
            } else {
                // Listening before opening the browser, so a sign-in that comes back instantly -
                // because the browser is already signed in to Serble - cannot arrive before there
                // is anything listening.
                let callback = login::Callback::listen(&state)?;

                if login::open_browser(&url) {
                    session.say("Opened your browser to sign in to Serble. Waiting...");
                } else {
                    println!("Could not open a browser. Open this yourself:\n\n  {url}\n");
                }
                callback.wait()?
            }
        }
    };

    let token = anonymous
        .authenticate(&code)
        .map_err(|e| format!("The server would not accept that sign-in: {e}"))?;

    // The address is written down only when this run named one. Saving it every time would pin a
    // build to whatever it happened to talk to first, and then a copy built for somewhere else
    // would keep going to the old place.
    if session.server_was_given {
        session.settings.server = Some(session.server.clone());
    }
    session.settings.token = Some(token.clone());
    session
        .settings
        .save()
        .map_err(|e| format!("Could not save the session: {e}"))?;
    session.token = Some(token);

    let account = session
        .backend()?
        .account()
        .map_err(|e| format!("Signed in, but could not read the account: {e}"))?;

    session.say(format!("Signed in as {} on {}.", account.username, session.server));
    session.say(format!(
        "The session is in {} (readable only by you).",
        serblenotes_fuse::config::settings_path().display()
    ));
    Ok(())
}

fn logout_command(session: &Session) -> Result<(), String> {
    let mut settings = Settings::load();
    settings.token = None;
    settings
        .save()
        .map_err(|e| format!("Could not clear the session: {e}"))?;

    session.say("Signed out on this machine.");
    session.say(format!(
        "Vault keys are still here. `serblenotes-fuse forget <vault>` removes one; see {}.",
        serblenotes_fuse::config::keys_path().display()
    ));
    Ok(())
}

fn whoami_command(session: &Session) -> Result<(), String> {
    let account = session
        .backend()?
        .account()
        .map_err(|e| session.explain(e))?;
    println!("{} on {}", account.username, session.server);
    Ok(())
}

fn vaults_command(session: &Session) -> Result<(), String> {
    let keys = KeyStore::load();
    let vaults = session
        .backend()?
        .list_vaults()
        .map_err(|e| session.explain(e))?;

    let live: Vec<&Vault> = vaults.iter().filter(|vault| !vault.deleted).collect();
    if live.is_empty() {
        session.say("No vaults on this account yet.");
        return Ok(());
    }

    for vault in live {
        let state = if unlock::needs_password(vault, &keys) {
            "locked on this machine"
        } else if vault.encrypted {
            "unlocked on this machine"
        } else {
            "not encrypted"
        };
        println!("{}  {}  ({state})", vault.id, vault.name);
    }

    Ok(())
}

fn forget_command(session: &Session, name: &str, discard_cache: bool) -> Result<(), String> {
    let vault = session.vault(name)?;

    let mut keys = KeyStore::load();
    let had = keys
        .forget(&vault.id)
        .map_err(|e| format!("Could not update the key store: {e}"))?;

    if had {
        session.say(format!("Forgot this machine's key for \"{}\".", vault.name));
    } else {
        session.say(format!("This machine was not holding a key for \"{}\".", vault.name));
    }

    if discard_cache {
        // Said plainly rather than done quietly: an unsent edit lives here and nowhere else.
        VaultCache::for_vault(&vault.id)
            .discard()
            .map_err(|e| format!("Could not remove the cached vault: {e}"))?;
        session.say("Removed this machine's cached copy of the vault, including any unsent edits.");
    }

    Ok(())
}

// --- mounting -----------------------------------------------------------------------------------

/// Set by SIGINT and SIGTERM. The only thing the handler does, because it is the only thing a
/// signal handler may safely do.
static STOP: AtomicBool = AtomicBool::new(false);

extern "C" fn on_signal(_signal: libc::c_int) {
    STOP.store(true, Ordering::SeqCst);
}

fn mount_command(
    session: &Session,
    name: &str,
    mountpoint: &Path,
    password: Password,
    options: MountOptions,
) -> Result<(), String> {
    let vault = session.vault(name)?;

    mountpoint::check(mountpoint, options.mkdir)?;

    // Before anything is unlocked or mounted: a pattern that will not compile is a flag the user
    // believes is working, and finding out later means finding a note they did not want.
    let ignore = Ignore::new(&options.ignore)?;

    let key = obtain_key(session, &vault, &password)?;

    // Everything the mount does goes through this second client, which carries the same session and
    // device id. The one above was used to find the vault and is done with.
    let sync_backend = HttpBackend::new(
        &session.server,
        session.token.clone(),
        session.device_id.clone(),
    );

    let mut store = VaultStore::new(&vault.id, &key, Box::new(sync_backend));
    let warm = store.hydrate();

    if vault.encrypted {
        session.say(format!(
            "Vault \"{}\" is {}.",
            vault.name,
            unlock::describe_privacy(&vault)
        ));
    } else {
        // Never quiet. Somebody mounting a vault on a server somewhere is not necessarily the
        // person who chose how it was made, and this is the one thing about it they have to know.
        log::warn!("Vault \"{}\" is {}.", vault.name, unlock::describe_privacy(&vault));
    }

    if warm {
        session.say("Opened this machine's cached copy; catching up with the server in the background.");
    } else if let Err(error) = store.pull() {
        // A vault with nothing cached and no server is a mount with nothing in it, which is worse
        // than a clear refusal.
        return Err(format!("Could not open the vault: {error}"));
    }

    let mount = Arc::new(Mutex::new(Mount::new(store, options.read_only, ignore)));

    let restored = sync::restore_unsent(&mount);
    if restored > 0 {
        session.say(format!(
            "Bringing back {restored} edit(s) this machine had not managed to send."
        ));
    }

    let stop = Arc::new(AtomicBool::new(false));
    let syncing = sync::spawn(
        Arc::clone(&mount),
        Duration::from_secs(options.interval.max(1)),
        Arc::clone(&stop),
    );

    let mut config = fuser::Config::default();
    config.mount_options = vec![
        MountOption::FSName("serblenotes".into()),
        MountOption::Subtype("serblenotes".into()),
        MountOption::NoDev,
        MountOption::NoSuid,
        MountOption::NoExec,
        MountOption::NoAtime,
        if options.read_only { MountOption::RO } else { MountOption::RW },
    ];
    config.acl = if options.allow_other {
        SessionACL::All
    } else {
        SessionACL::Owner
    };

    let fuse = fuser::spawn_mount(VaultFs::new(Arc::clone(&mount)), mountpoint, &config)
        .map_err(|e| format!("Could not mount at {}: {e}", mountpoint.display()))?;

    unsafe {
        libc::signal(libc::SIGINT, on_signal as *const () as libc::sighandler_t);
        libc::signal(libc::SIGTERM, on_signal as *const () as libc::sighandler_t);
    }

    session.say(format!("Mounted at {}.", mountpoint.display()));
    session.say("Every time a file is closed after being written to, that becomes a new version.");
    session.say("Press Ctrl-C to unmount.");

    while !STOP.load(Ordering::SeqCst) {
        std::thread::sleep(Duration::from_millis(200));
    }

    // Told to stop before the unmount, so it does not begin a fetch the unmount then has to wait
    // out. It checks between notes, so this takes effect within one request.
    stop.store(true, Ordering::Relaxed);

    let outcome = take_down(session, mountpoint);

    // Only waited for when the mount is really gone. After a detach the worker can still be parked
    // on a descriptor another program is holding, and waiting for it is the hang this exists to
    // avoid - the thread goes when the process does.
    if matches!(outcome, Ok(Unmounted::Cleanly)) {
        let _ = fuse.join();
    } else {
        std::mem::forget(fuse);
    }

    let _ = syncing.join();

    // The last chance to send anything still outstanding, now that nothing can add to it.
    sync::tick(&mount);

    let outstanding = {
        let guard = mount.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        guard.unsent_count()
    };
    if outstanding > 0 {
        eprintln!(
            "{outstanding} edit(s) could not be sent. They are sealed on this machine and will go \
             out the next time this vault is mounted."
        );
    }

    outcome.map(|_| ())
}

/// The mount point, a signal handler and a clock, for `mountpoint::take_down`.
struct RealUnmounting<'a> {
    mountpoint: &'a Path,
    session: &'a Session,
}

impl Unmounting for RealUnmounting<'_> {
    fn attempt(&mut self, detach: bool) -> Result<(), String> {
        unmount(self.mountpoint, detach)
    }

    /// A second Ctrl-C, which means something different from the first one now.
    fn detach_requested(&mut self) -> bool {
        STOP.load(Ordering::SeqCst)
    }

    fn explain(&mut self, why: &str) {
        eprintln!("{} is still in use: {why}", self.mountpoint.display());
        eprintln!(
            "Close whatever has a file open there and this will finish on its own, or press \
             Ctrl-C again to detach it - anything still holding a file will get an error."
        );
    }

    fn wait(&mut self) {
        let _ = &self.session;
        std::thread::sleep(Duration::from_millis(300));
    }
}

fn take_down(session: &Session, mountpoint: &Path) -> Result<Unmounted, String> {
    session.say("Unmounting...");

    // The first Ctrl-C got us here; from now on another one means "detach it anyway".
    STOP.store(false, Ordering::SeqCst);

    let outcome = mountpoint::take_down(&mut RealUnmounting { mountpoint, session })
        .map_err(|why| format!("Could not detach {}: {why}", mountpoint.display()))?;

    if outcome == Unmounted::Detached {
        eprintln!("Detached {}.", mountpoint.display());
    }

    Ok(outcome)
}

/// The key for a vault, asking a person only if nothing else supplied one.
///
/// Which source applies is `unlock::password_source`, which is tested; this is the part that
/// actually reads from stdin, a terminal or the environment.
fn obtain_key(session: &Session, vault: &Vault, password: &Password) -> Result<String, String> {
    let mut keys = KeyStore::load();

    if let Some(key) = unlock::cached_key(vault, &keys) {
        return Ok(key);
    }

    let supplied = match password_source(
        password.given.as_deref(),
        password.from_stdin,
        std::env::var("SERBLENOTES_VAULT_PASSWORD").ok().as_deref(),
    ) {
        PasswordSource::Given(given) => {
            // Factual, once, and it does not refuse: it is the user's machine and their call. The
            // alternatives are named because they cost nothing and do the same job.
            log::warn!(
                "A password given with --password is visible to anyone who can list processes on \
                 this machine, and is usually kept in your shell history. --password-stdin and \
                 SERBLENOTES_VAULT_PASSWORD are not."
            );
            given
        }
        PasswordSource::Stdin => {
            let mut typed = String::new();
            std::io::stdin()
                .read_line(&mut typed)
                .map_err(|e| format!("Could not read the password: {e}"))?;
            // Only the newline. A vault password may be anything, including spaces and an empty
            // string, and trimming it would turn a correct password into a wrong one.
            typed.strip_suffix('\n').unwrap_or(&typed).to_string()
        }
        PasswordSource::Environment(password) => password,
        PasswordSource::Ask => {
            rpassword::prompt_password(format!("Password for \"{}\": ", vault.name)).map_err(|e| {
                format!(
                    "This vault needs a password and there is no terminal to ask on ({e}). Pass \
                     --password, --password-stdin, or set SERBLENOTES_VAULT_PASSWORD."
                )
            })?
        }
    };

    let key = unlock::unlock(vault, &supplied)?;

    if password.remember {
        keys.remember(&vault.id, &key)
            .map_err(|e| format!("Unlocked, but could not remember the key: {e}"))?;
        session.say(unlock::describe_key_storage());
    }

    Ok(key)
}

// --- shared -------------------------------------------------------------------------------------

