//! The JSON-RPC methods Unlisted's API uses. Names follow zcashd where one
//! exists; idempotent sends, sweeps, transaction status and account deletion
//! are unlisted-wallet extensions.

use std::sync::Arc;

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    Json,
};
use base64::Engine as _;
use subtle::ConstantTimeEq;
use serde_json::{json, Value};
use zcash_protocol::{memo::MemoBytes, value::Zatoshis};

use crate::wallet::{OpState, PrivacyPolicy, Recipient, TxState, Wallet};

pub struct RpcState {
    pub wallet: Arc<Wallet>,
    /// Expected value of the Authorization header, if auth is enabled.
    pub auth: Option<String>,
    pub lightwalletd: String,
}

pub fn basic_auth(user: &str, password: &str) -> String {
    format!("Basic {}", base64::engine::general_purpose::STANDARD.encode(format!("{user}:{password}")))
}

struct RpcError(i64, String);

impl<E: std::fmt::Display> From<E> for RpcError {
    fn from(e: E) -> Self {
        let msg = e.to_string();
        let code = if msg.to_lowercase().contains("insufficient") { -6 } else { -1 };
        RpcError(code, msg)
    }
}

fn param_err(msg: impl Into<String>) -> RpcError {
    RpcError(-8, msg.into())
}

pub async fn handle(State(state): State<Arc<RpcState>>, headers: HeaderMap, Json(body): Json<Value>) -> impl IntoResponse {
    if let Some(expected) = &state.auth {
        let given = headers.get("authorization").map(|v| v.as_bytes()).unwrap_or_default();
        // Constant time, so the password can't be recovered by timing guesses.
        if !bool::from(given.ct_eq(expected.as_bytes())) {
            return (StatusCode::UNAUTHORIZED, Json(json!({"result": null, "error": {"code": -32600, "message": "unauthorized"}, "id": null})));
        }
    }
    let id = body.get("id").cloned().unwrap_or(Value::Null);
    let method = body.get("method").and_then(Value::as_str).unwrap_or_default().to_string();
    let params = body.get("params").and_then(Value::as_array).cloned().unwrap_or_default();
    match dispatch(&state, &method, &params).await {
        Ok(result) => (StatusCode::OK, Json(json!({"result": result, "error": null, "id": id}))),
        Err(RpcError(code, message)) => {
            (StatusCode::OK, Json(json!({"result": null, "error": {"code": code, "message": message}, "id": id})))
        }
    }
}

fn str_param<'a>(params: &'a [Value], i: usize, name: &str) -> Result<&'a str, RpcError> {
    params.get(i).and_then(Value::as_str).ok_or_else(|| param_err(format!("{name} must be a string")))
}

fn memo_param(v: Option<&Value>) -> Result<MemoBytes, RpcError> {
    let memo_hex = v.and_then(Value::as_str).unwrap_or("");
    let memo_bytes = hex::decode(memo_hex).map_err(|_| param_err("memo must be hex"))?;
    MemoBytes::from_bytes(&memo_bytes).map_err(|_| param_err("memo longer than 512 bytes"))
}

/// Parse a ZEC amount exactly, from either a JSON string or number.
fn parse_zec(v: &Value) -> Result<Zatoshis, RpcError> {
    let text = match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        _ => return Err(param_err("amount must be a number")),
    };
    let (whole, frac) = text.split_once('.').unwrap_or((&text, ""));
    if whole.is_empty() || !whole.chars().all(|c| c.is_ascii_digit()) || frac.len() > 8 || !frac.chars().all(|c| c.is_ascii_digit()) {
        return Err(param_err(format!("invalid amount {text}")));
    }
    let zat = whole.parse::<u64>().map_err(|_| param_err("amount too large"))? * 100_000_000
        + format!("{frac:0<8}").parse::<u64>().unwrap_or(0);
    Zatoshis::from_u64(zat).map_err(|_| param_err("amount out of range"))
}

async fn dispatch(state: &RpcState, method: &str, params: &[Value]) -> Result<Value, RpcError> {
    let w = &state.wallet;
    match method {
        "getblockcount" => Ok(json!(w.tip())),

        "getwalletinfo" => Ok(json!({
            "network": w.network_name(),
            "chain_tip": w.tip(),
            "fully_scanned_height": w.scanned(),
            "lightwalletd": state.lightwalletd,
        })),

        "z_getnewaccount" => Ok(json!({"account": w.new_account().await?})),

        "z_getaddressforaccount" => {
            let account = str_param(params, 0, "account")?;
            let receivers: Vec<String> = params
                .get(1)
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
                .unwrap_or_else(|| vec!["orchard".into()]);
            let orchard = receivers.iter().any(|r| r == "orchard");
            let sapling = receivers.iter().any(|r| r == "sapling");
            if receivers.iter().any(|r| r != "orchard" && r != "sapling") {
                return Err(param_err("only orchard and sapling receivers are supported"));
            }
            let address = w.address_for(account, orchard, sapling).await?;
            Ok(json!({"account": account, "receiver_types": receivers, "address": address}))
        }

        "z_listreceivedbyaddress" => {
            let address = str_param(params, 0, "address")?;
            let minconf = params.get(1).and_then(Value::as_u64).unwrap_or(1) as u32;
            let since = params.get(2).and_then(Value::as_u64).unwrap_or(0) as u32;
            let rows = w
                .received_at(address, since)?
                .into_iter()
                .map(|o| {
                    let conf = w.confirmations(o.mined_height);
                    (o, conf)
                })
                .filter(|(_, conf)| *conf >= minconf)
                .map(|(o, conf)| {
                    let index_key = if o.pool == "orchard" { "actionIndex" } else { "outindex" };
                    json!({
                        "pool": o.pool,
                        "txid": o.txid,
                        "amountZat": o.value,
                        "memo": hex::encode(&o.memo),
                        index_key: o.index,
                        "confirmations": conf,
                        "blockheight": o.mined_height,
                        "change": false,
                    })
                })
                .collect::<Vec<_>>();
            Ok(json!(rows))
        }

        "z_getbalanceforaccount" => {
            let (spendable, pending) = w.balance(str_param(params, 0, "account")?)?;
            Ok(json!({"spendableZat": spendable, "pendingZat": pending}))
        }

        "z_sendmany" => {
            let from = str_param(params, 0, "fromaddress")?;
            let amounts = params.get(1).and_then(Value::as_array).ok_or_else(|| param_err("amounts must be an array"))?;
            if amounts.is_empty() {
                return Err(param_err("no recipients"));
            }
            let policy = PrivacyPolicy::parse(params.get(4).and_then(Value::as_str)).map_err(|e| param_err(e.to_string()))?;
            let key = str_param(params, 5, "idempotency key")?;
            let mut recipients = vec![];
            for a in amounts {
                let address = a.get("address").and_then(Value::as_str).ok_or_else(|| param_err("recipient address missing"))?;
                let amount = parse_zec(a.get("amount").ok_or_else(|| param_err("amount missing"))?)?;
                recipients.push(Recipient { address: address.to_string(), amount, memo: memo_param(a.get("memo"))? });
            }
            let account = w.account_for_address(from)?;
            let kind = w.transfer_request(recipients, policy)?;
            Ok(json!(w.submit(key, &account, kind)?))
        }

        "z_sweep" => {
            let from = str_param(params, 0, "fromaddress")?;
            let to = str_param(params, 1, "toaddress")?;
            let memo = memo_param(params.get(2))?;
            let key = str_param(params, 3, "idempotency key")?;
            let account = w.account_for_address(from)?;
            let kind = w.sweep_request(to, memo)?;
            Ok(json!(w.submit(key, &account, kind)?))
        }

        "z_getoperationstatus" => {
            let ids: Vec<String> = params
                .first()
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
                .unwrap_or_default();
            let mut out = vec![];
            for id in &ids {
                if let Some(s) = w.op_status(id)? {
                    out.push(match s {
                        OpState::Executing => json!({"id": id, "status": "executing"}),
                        OpState::Success { txid, amount } => {
                            json!({"id": id, "status": "success", "result": {"txid": txid, "amountZat": amount}})
                        }
                        OpState::Failed(msg) => json!({"id": id, "status": "failed", "error": {"code": -6, "message": msg}}),
                    });
                }
            }
            Ok(json!(out))
        }

        "gettransaction" => {
            let txid = str_param(params, 0, "txid")?;
            match w.tx_state(txid)? {
                Some(TxState::Mined { confirmations }) => Ok(json!({"txid": txid, "status": "mined", "confirmations": confirmations})),
                Some(TxState::Pending) => Ok(json!({"txid": txid, "status": "pending", "confirmations": 0})),
                Some(TxState::Expired) => Ok(json!({"txid": txid, "status": "expired", "confirmations": 0})),
                None => Err(RpcError(-5, format!("transaction {txid} unknown to this wallet"))),
            }
        }

        "z_deleteaccount" => {
            w.delete_account(str_param(params, 0, "account")?).await?;
            Ok(json!(true))
        }

        "z_listunifiedreceivers" => Ok(w.parse_ua_receivers(str_param(params, 0, "unified_address")?)?),

        _ => Err(RpcError(-32601, format!("Method not found: {method}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn amounts_parse_exactly() {
        let zat = |v: Value| parse_zec(&v).map(|z| z.into_u64()).ok();
        assert_eq!(zat(json!("0.005")), Some(500_000));
        assert_eq!(zat(json!("1")), Some(100_000_000));
        assert_eq!(zat(json!("0.00000001")), Some(1));
        assert_eq!(zat(json!(0.1)), Some(10_000_000));
        assert_eq!(zat(json!("0.000000001")), None);
        assert_eq!(zat(json!("-1")), None);
        assert_eq!(zat(json!("1e3")), None);
    }
}
