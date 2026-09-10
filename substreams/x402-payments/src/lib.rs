mod hits;

use hits::Hits;
use substreams::log;
use substreams_ethereum::pb::eth::v2::Block;

/// Params: comma-separated 0x addresses (USDC, batch-settlement, Permit2)
/// discovered live via `getCode` — never hardcoded in the module.
#[substreams::handlers::map]
fn map_x402_payments(params: String, blk: Block) -> Result<Hits, substreams::errors::Error> {
    let want: Vec<String> = params
        .split(',')
        .map(|s| s.trim().trim_start_matches("0x").to_ascii_lowercase())
        .filter(|s| !s.is_empty())
        .collect();

    let mut txs = Vec::new();
    let mut addresses = Vec::new();
    for trx in &blk.transaction_traces {
        let hash = substreams::Hex(&trx.hash).to_string();
        if let Some(receipt) = &trx.receipt {
            for lg in &receipt.logs {
                let addr = substreams::Hex(&lg.address).to_string().to_ascii_lowercase();
                if want.iter().any(|w| w == &addr) {
                    log::info!("x402_hit tx=0x{} address=0x{} block={}", hash, addr, blk.number);
                    txs.push(format!("0x{hash}"));
                    addresses.push(format!("0x{addr}"));
                }
            }
        }
    }
    Ok(Hits {
        block: blk.number,
        txs,
        addresses,
    })
}
