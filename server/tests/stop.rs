use std::time::{Duration, Instant};

use cofisher_server::{start, ServerOptions};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[tokio::test]
async fn stop_does_not_wait_for_unresponsive_peers_and_frees_the_port() {
    let mut opts = ServerOptions::host_mode(0, String::new());
    opts.host = "127.0.0.1".into();
    let server = start(opts.clone()).await.unwrap();
    let port = server.port;

    // Complete the WebSocket upgrade, then never answer anything (like a sleeping laptop).
    let mut raw = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    raw.write_all(b"GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n").await.unwrap();
    let mut buf = [0u8; 256];
    let n = raw.read(&mut buf).await.unwrap();
    assert!(String::from_utf8_lossy(&buf[..n]).contains("101"));

    let t0 = Instant::now();
    server.stop().await;
    assert!(t0.elapsed() < Duration::from_secs(3), "stop took {:?}", t0.elapsed());

    // Hosting again on the same port must work right away.
    opts.port = port;
    start(opts).await.expect("port should be free after stop").stop().await;
}
