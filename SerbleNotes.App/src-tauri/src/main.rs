// A Windows release build should not open a console window behind the app.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    serblenotes_app_lib::run()
}
