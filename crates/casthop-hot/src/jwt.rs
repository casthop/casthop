//! LiveKit-compatible HS256 JWT used by token mint, webhook, and egress-beat.
//! Software HMAC in WASM; the TS Worker uses WebCrypto (host BoringSSL).

use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use hmac::{Hmac, Mac};
use serde::Serialize;
use sha2::{Digest, Sha256};

type HmacSha256 = Hmac<Sha256>;

const GUEST_TTL_SEC: u64 = 6 * 60 * 60;
const HOST_TTL_SEC: u64 = 10 * 60;
const WEBHOOK_TTL_SEC: u64 = 10 * 60;
const CLOCK_SKEW_SEC: u64 = 10;

#[derive(Serialize)]
struct JwtHeader {
    alg: &'static str,
    typ: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct VideoGrant {
    #[serde(skip_serializing_if = "Option::is_none")]
    room: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    room_join: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    can_publish: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    can_subscribe: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    can_publish_data: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    can_update_own_metadata: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    room_admin: Option<bool>,
}

#[derive(Serialize)]
struct ParticipantClaims<'a> {
    iss: &'a str,
    sub: &'a str,
    name: &'a str,
    nbf: u64,
    exp: u64,
    jti: &'a str,
    video: VideoGrant,
}

#[derive(Serialize)]
struct WebhookClaims<'a> {
    iss: &'a str,
    nbf: u64,
    exp: u64,
    sha256: &'a str,
}

pub struct ParticipantToken {
    pub identity: String,
    pub room: String,
}

fn b64url_json(value: &impl Serialize) -> Option<String> {
    let json = serde_json::to_vec(value).ok()?;
    Some(URL_SAFE_NO_PAD.encode(json))
}

fn hmac_sha256(secret: &[u8], data: &[u8]) -> Option<[u8; 32]> {
    let mut mac = HmacSha256::new_from_slice(secret).ok()?;
    mac.update(data);
    let bytes = mac.finalize().into_bytes();
    let mut out = [0u8; 32];
    out.copy_from_slice(&bytes);
    Some(out)
}

fn hmac_b64url(secret: &str, data: &str) -> Option<String> {
    let sig = hmac_sha256(secret.as_bytes(), data.as_bytes())?;
    Some(URL_SAFE_NO_PAD.encode(sig))
}

fn timing_equal(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.bytes().zip(b.bytes()) {
        diff |= x ^ y;
    }
    diff == 0
}

fn now_secs() -> u64 {
    #[cfg(target_arch = "wasm32")]
    {
        (js_sys::Date::now() / 1000.0) as u64
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0)
    }
}

fn random_uuid() -> String {
    let mut b = [0u8; 16];
    if getrandom::getrandom(&mut b).is_err() {
        return String::new();
    }
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7], b[8], b[9], b[10], b[11], b[12], b[13], b[14], b[15]
    )
}

fn sign(_api_key: &str, api_secret: &str, claims: &impl Serialize) -> Option<String> {
    let header = JwtHeader {
        alg: "HS256",
        typ: "JWT",
    };
    let unsigned = format!("{}.{}", b64url_json(&header)?, b64url_json(claims)?);
    let sig = hmac_b64url(api_secret, &unsigned)?;
    Some(format!("{unsigned}.{sig}"))
}

struct Mint<'a> {
    api_key: &'a str,
    api_secret: &'a str,
    identity: &'a str,
    name: &'a str,
    room: &'a str,
    can_publish: bool,
    can_publish_data: bool,
    room_admin: bool,
    ttl_sec: u64,
}

/// Host or guest LiveKit participant JWT. Same claims as `worker/livekit.ts`.
fn mint_participant_token(opts: Mint<'_>) -> Option<String> {
    let now = now_secs();
    let jti = random_uuid();
    let claims = ParticipantClaims {
        iss: opts.api_key,
        sub: opts.identity,
        name: opts.name,
        nbf: now.saturating_sub(CLOCK_SKEW_SEC),
        exp: now.saturating_add(opts.ttl_sec),
        jti: &jti,
        video: VideoGrant {
            room: Some(opts.room.to_string()),
            room_join: Some(true),
            can_publish: Some(opts.can_publish),
            can_subscribe: Some(true),
            can_publish_data: Some(opts.can_publish_data),
            can_update_own_metadata: Some(false),
            room_admin: Some(opts.room_admin),
        },
    };
    sign(opts.api_key, opts.api_secret, &claims)
}

pub fn mint_guest_token(
    api_key: &str,
    api_secret: &str,
    identity: &str,
    name: &str,
    room: &str,
    can_publish: bool,
) -> Option<String> {
    mint_participant_token(Mint {
        api_key,
        api_secret,
        identity,
        name,
        room,
        can_publish,
        can_publish_data: false,
        room_admin: false,
        ttl_sec: GUEST_TTL_SEC,
    })
}

pub fn mint_host_token(
    api_key: &str,
    api_secret: &str,
    identity: &str,
    name: &str,
    room: &str,
) -> Option<String> {
    mint_participant_token(Mint {
        api_key,
        api_secret,
        identity,
        name,
        room,
        can_publish: true,
        can_publish_data: true,
        room_admin: true,
        ttl_sec: HOST_TTL_SEC,
    })
}

fn strip_bearer(header: &str) -> &str {
    let trimmed = header.trim();
    if let Some(rest) = trimmed
        .strip_prefix("Bearer ")
        .or_else(|| trimmed.strip_prefix("bearer "))
    {
        rest.trim()
    } else {
        trimmed
    }
}

fn split_jwt(token: &str) -> Option<(&str, &str, &str)> {
    let mut parts = token.split('.');
    let header = parts.next()?;
    let payload = parts.next()?;
    let sig = parts.next()?;
    if parts.next().is_some() || header.is_empty() || payload.is_empty() || sig.is_empty() {
        return None;
    }
    Some((header, payload, sig))
}

fn verify_hs256(api_key: &str, api_secret: &str, token: &str) -> Option<serde_json::Value> {
    let (header, payload, sig) = split_jwt(token)?;
    let unsigned = format!("{header}.{payload}");
    let expected = hmac_b64url(api_secret, &unsigned)?;
    let got = sig.trim_end_matches('=');
    if !timing_equal(&expected, got) {
        return None;
    }
    let json_bytes = URL_SAFE_NO_PAD.decode(payload).ok()?;
    let claims: serde_json::Value = serde_json::from_slice(&json_bytes).ok()?;
    if claims.get("iss").and_then(serde_json::Value::as_str) != Some(api_key) {
        return None;
    }
    let exp = claims.get("exp").and_then(serde_json::Value::as_u64)?;
    let now = now_secs();
    if exp + CLOCK_SKEW_SEC < now {
        return None;
    }
    if let Some(nbf) = claims.get("nbf").and_then(serde_json::Value::as_u64) {
        if nbf > now + CLOCK_SKEW_SEC {
            return None;
        }
    }
    Some(claims)
}

pub fn verify_participant_token(
    api_key: &str,
    api_secret: &str,
    authorization: Option<&str>,
) -> Option<ParticipantToken> {
    let header = authorization?;
    let claims = verify_hs256(api_key, api_secret, strip_bearer(header))?;
    let identity = claims
        .get("sub")
        .and_then(serde_json::Value::as_str)
        .filter(|s| !s.is_empty())?;
    let room = claims
        .get("video")
        .and_then(|v| v.get("room"))
        .and_then(serde_json::Value::as_str)
        .filter(|s| !s.is_empty())?;
    Some(ParticipantToken {
        identity: identity.to_string(),
        room: room.to_string(),
    })
}

fn sha256_b64(body: &str) -> String {
    let digest = Sha256::digest(body.as_bytes());
    STANDARD.encode(digest)
}

pub fn verify_livekit_webhook(
    api_key: &str,
    api_secret: &str,
    authorization: Option<&str>,
    body: &str,
) -> bool {
    let Some(header) = authorization else {
        return false;
    };
    let Some(claims) = verify_hs256(api_key, api_secret, strip_bearer(header)) else {
        return false;
    };
    let Some(claimed) = claims
        .get("sha256")
        .and_then(serde_json::Value::as_str)
        .filter(|s| !s.is_empty())
    else {
        return false;
    };
    timing_equal(&sha256_b64(body), claimed)
}

pub fn sign_livekit_webhook(api_key: &str, api_secret: &str, body: &str) -> Option<String> {
    let now = now_secs();
    let sha = sha256_b64(body);
    let claims = WebhookClaims {
        iss: api_key,
        nbf: now.saturating_sub(CLOCK_SKEW_SEC),
        exp: now.saturating_add(WEBHOOK_TTL_SEC),
        sha256: &sha,
    };
    sign(api_key, api_secret, &claims)
}

pub fn guest_ttl_sec() -> u64 {
    GUEST_TTL_SEC
}

pub fn host_ttl_sec() -> u64 {
    HOST_TTL_SEC
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &str = "devkey";
    const SECRET: &str = "casthop_dev_secret_not_for_production_use_32b";

    #[test]
    fn participant_roundtrip() {
        let token = mint_host_token(KEY, SECRET, "host", "Ada", "studio-a").expect("mint");
        let claims = verify_participant_token(KEY, SECRET, Some(&format!("Bearer {token}")))
            .expect("verify");
        assert_eq!(claims.identity, "host");
        assert_eq!(claims.room, "studio-a");
    }

    #[test]
    fn guest_cannot_use_wrong_secret() {
        let token = mint_guest_token(KEY, SECRET, "g-1", "Guest", "studio-a", false).expect("mint");
        assert!(verify_participant_token(KEY, "other-secret", Some(&token)).is_none());
        assert!(verify_participant_token("other-key", SECRET, Some(&token)).is_none());
        assert!(verify_participant_token(KEY, SECRET, None).is_none());
    }

    #[test]
    fn webhook_roundtrip() {
        let body = r#"{"event":"egress_ended","room":{"name":"studio-a"}}"#;
        let token = sign_livekit_webhook(KEY, SECRET, body).expect("sign");
        assert!(verify_livekit_webhook(KEY, SECRET, Some(&token), body));
        assert!(!verify_livekit_webhook(
            KEY,
            SECRET,
            Some(&token),
            r#"{"event":"tamper"}"#
        ));
        assert!(!verify_livekit_webhook(
            KEY,
            SECRET,
            Some("Bearer nope"),
            body
        ));
        assert!(!verify_livekit_webhook(KEY, SECRET, None, body));
    }

    #[test]
    fn hmac_is_url_safe_unpadded() {
        let token = mint_guest_token(KEY, SECRET, "g-1", "G", "r", true).expect("mint");
        let sig = token.split('.').nth(2).expect("sig");
        assert!(!sig.contains('+'));
        assert!(!sig.contains('/'));
        assert!(!sig.contains('='));
    }
}
