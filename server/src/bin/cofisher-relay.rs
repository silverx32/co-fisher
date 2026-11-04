//! Standalone relay for playing across networks without anyone hosting:
//!   cofisher-relay [--port 23333] [--password secret] [--host ::] [--max-rooms 500]
//!                  [--boss-hp 1500] [--boss-cooldown 1200]
//! Friends join with the relay's address plus a shared room code.

use std::time::Duration;

use cofisher_server::{start, ServerOptions, DEFAULT_PORT};

fn usage() -> ! {
    eprintln!("用法: cofisher-relay [--port 23333] [--password 密码] [--host ::] [--max-rooms 500] [--single-room]");
    eprintln!("                     [--boss-hp 每人血量] [--boss-cooldown Boss 冷却秒数]");
    std::process::exit(2);
}

#[tokio::main]
async fn main() {
    let mut opts = ServerOptions::relay(DEFAULT_PORT, String::new());
    let mut args = std::env::args().skip(1);
    while let Some(flag) = args.next() {
        let mut value = || args.next().unwrap_or_else(|| usage());
        match flag.as_str() {
            "--port" => opts.port = value().parse().unwrap_or_else(|_| usage()),
            "--password" => opts.password = value(),
            "--host" => opts.host = value(),
            "--max-rooms" => opts.max_rooms = value().parse().unwrap_or_else(|_| usage()),
            "--boss-hp" => opts.boss_hp = value().parse().ok().filter(|n| *n > 0).unwrap_or_else(|| usage()),
            "--boss-cooldown" => opts.boss_cooldown = Duration::from_secs(value().parse().unwrap_or_else(|_| usage())),
            // Behave like an in-app host: one room, room codes ignored.
            "--single-room" => opts = ServerOptions { single_room: true, max_rooms: 1, ..opts },
            _ => usage(),
        }
    }
    let server = match start(opts.clone()).await {
        Ok(s) => s,
        Err(e) => {
            eprintln!("启动失败: {e}");
            std::process::exit(1);
        }
    };
    // Tests and scripts read this line to learn the port (useful with --port 0).
    println!("listening on {}", server.port);
    println!("co-fisher relay ready (password: {})", if opts.password.is_empty() { "无" } else { "已设置" });
    let _ = tokio::signal::ctrl_c().await;
    server.stop().await;
}
