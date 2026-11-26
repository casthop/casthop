//! workers-rs Worker used to measure hot `/api` CPU against the TS Worker.
//! Live traffic stays on the Hono Worker; this crate is the comparison.

mod jwt;

pub use jwt::{
    guest_ttl_sec, host_ttl_sec, mint_guest_token, mint_host_token, sign_livekit_webhook,
    verify_livekit_webhook, verify_participant_token, ParticipantToken,
};

#[cfg(target_arch = "wasm32")]
mod wasm_worker {
    use super::jwt;
    use serde::Serialize;
    use serde_json::json;
    use wasm_bindgen::prelude::*;
    use worker::*;

    #[wasm_bindgen]
    extern "C" {
        #[wasm_bindgen(js_namespace = performance)]
        fn now() -> f64;
    }

    fn keys(env: &Env) -> Result<(String, String)> {
        let key = env.var("LIVEKIT_API_KEY")?.to_string();
        let secret = env.var("LIVEKIT_API_SECRET")?.to_string();
        Ok((key, secret))
    }

    fn json_ok(value: impl Serialize) -> Result<Response> {
        Response::from_json(&value)
    }

    fn json_err(status: u16, error: &str) -> Result<Response> {
        let mut res = Response::from_json(&json!({ "error": error }))?;
        res.headers_mut().set("Content-Type", "application/json")?;
        Ok(res.with_status(status))
    }

    async fn handle(req: Request, env: Env) -> Result<Response> {
        let path = req.path();
        let method = req.method();
        match (method, path.as_str()) {
            (Method::Get, "/api/health") => json_ok(json!({
                "ok": true,
                "livekit": { "ok": true },
                "impl": "workers-rs",
            })),
            (Method::Post, "/internal/cpu") => cpu_bench(req, env).await,
            (Method::Post, "/internal/token") => mint_one(req, env).await,
            (Method::Post, "/internal/verify") => verify_one(req, env).await,
            (Method::Post, "/api/livekit/webhook") => webhook(req, env).await,
            _ => json_err(404, "not found"),
        }
    }

    async fn mint_one(mut req: Request, env: Env) -> Result<Response> {
        let (key, secret) = keys(&env)?;
        let body: serde_json::Value = req.json().await.unwrap_or_else(|_| json!({}));
        let identity = body
            .get("identity")
            .and_then(|v| v.as_str())
            .unwrap_or("g-bench");
        let name = body.get("name").and_then(|v| v.as_str()).unwrap_or("Guest");
        let room = body.get("room").and_then(|v| v.as_str()).unwrap_or("bench");
        let host = body.get("role").and_then(|v| v.as_str()) == Some("host");
        let token = if host {
            jwt::mint_host_token(&key, &secret, identity, name, room)
        } else {
            jwt::mint_guest_token(&key, &secret, identity, name, room, false)
        };
        let Some(token) = token else {
            return json_err(500, "mint failed");
        };
        json_ok(json!({
            "token": token,
            "identity": identity,
            "name": name,
            "role": if host { "host" } else { "guest" },
            "expiresIn": if host { jwt::host_ttl_sec() } else { jwt::guest_ttl_sec() },
        }))
    }

    async fn verify_one(mut req: Request, env: Env) -> Result<Response> {
        let (key, secret) = keys(&env)?;
        let body: serde_json::Value = req.json().await.unwrap_or_else(|_| json!({}));
        let token = body.get("token").and_then(|v| v.as_str()).unwrap_or("");
        let webhook_body = body.get("body").and_then(|v| v.as_str());
        if let Some(raw) = webhook_body {
            let ok = jwt::verify_livekit_webhook(&key, &secret, Some(token), raw);
            return json_ok(json!({ "ok": ok, "kind": "webhook" }));
        }
        match jwt::verify_participant_token(&key, &secret, Some(token)) {
            Some(claims) => json_ok(json!({
                "ok": true,
                "kind": "participant",
                "identity": claims.identity,
                "room": claims.room,
            })),
            None => json_ok(json!({ "ok": false, "kind": "participant" })),
        }
    }

    async fn webhook(mut req: Request, env: Env) -> Result<Response> {
        let (key, secret) = keys(&env)?;
        let auth = req.headers().get("Authorization")?;
        let raw = req.text().await.unwrap_or_default();
        if !jwt::verify_livekit_webhook(&key, &secret, auth.as_deref(), &raw) {
            return json_err(401, "unauthorized");
        }
        json_ok(json!({ "ok": true }))
    }

    async fn cpu_bench(mut req: Request, env: Env) -> Result<Response> {
        let (key, secret) = keys(&env)?;
        let body: serde_json::Value = req.json().await.unwrap_or_else(|_| json!({}));
        let n = body
            .get("n")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(1)
            .clamp(1, 20_000);
        let op = body
            .get("op")
            .and_then(|v| v.as_str())
            .unwrap_or("jwt-mint");
        let t0 = now();
        match op {
            "jwt-verify" => {
                let token = match jwt::mint_host_token(&key, &secret, "host", "Ada", "bench") {
                    Some(t) => t,
                    None => return json_err(500, "mint failed"),
                };
                let header = format!("Bearer {token}");
                for _ in 0..n {
                    if jwt::verify_participant_token(&key, &secret, Some(&header)).is_none() {
                        return json_err(500, "verify failed");
                    }
                }
            }
            "webhook-verify" => {
                let payload = r#"{"event":"track_published","room":{"name":"bench"}}"#;
                let token = match jwt::sign_livekit_webhook(&key, &secret, payload) {
                    Some(t) => t,
                    None => return json_err(500, "sign failed"),
                };
                for _ in 0..n {
                    if !jwt::verify_livekit_webhook(&key, &secret, Some(&token), payload) {
                        return json_err(500, "webhook verify failed");
                    }
                }
            }
            _ => {
                for i in 0..n {
                    let identity = if i % 2 == 0 { "g-bench" } else { "host" };
                    if jwt::mint_guest_token(&key, &secret, identity, "Guest", "bench", false)
                        .is_none()
                    {
                        return json_err(500, "mint failed");
                    }
                }
            }
        }
        let ms = now() - t0;
        json_ok(json!({
            "impl": "workers-rs",
            "op": op,
            "n": n,
            "ms": ms,
            "perOpUs": (ms * 1000.0) / (n as f64),
        }))
    }

    #[event(fetch)]
    async fn fetch(req: Request, env: Env, _ctx: Context) -> Result<Response> {
        handle(req, env).await
    }
}
