/**
 * AWS Lambda handler for Oracle price validation
 *
 * This validator checks price updates against Coinbase exchange rates.
 *
 * StateDatum Structure (Aiken):
 *   admin: ScriptHash
 *   main_validator_hash: ScriptHash
 *   mint_validator_hash: ScriptHash
 *   current_market_id: Int
 *   old_price: Int
 *   new_price: Int          <- Validated field (USD with precision 10,000)
 *   winner: Option<PositionType>
 *   winner_odds: Int
 *   platform_fee: Int
 *   platform_address: Address
 */

import { type APIGatewayProxyEventV2 } from "aws-lambda"
import { bytesToHex, hexToBytes } from "@helios-lang/codec-utils"
import {
    ADA,
    decodeTx,
    makeShelleyAddress,
    TxOutput,
    type Signature,
    type Tx
} from "@helios-lang/ledger"
import {
    BlockfrostV0Client,
    makeBip32PrivateKey,
    makeBlockfrostV0Client
} from "@helios-lang/tx-utils"
import { expectDefined } from "@helios-lang/type-utils"
import { expectConstrData, expectIntData } from "@helios-lang/uplc"

// ============================================================================
// Configuration
// ============================================================================

const MAX_REL_DIFF = 0.01 // 1% tolerance

const PRIVATE_KEY = expectDefined(
    process.env.PRIVATE_KEY,
    "PRIVATE_KEY not set"
)

const BLOCKFROST_API_KEY = expectDefined(
    process.env.BLOCKFROST_API_KEY,
    "BLOCKFROST_API_KEY not set"
)

const DVP_ASSETS_VALIDATOR_ADDRESS_STRING = expectDefined(
    process.env.DVP_ASSETS_VALIDATOR_ADDRESS,
    "DVP_ASSETS_VALIDATOR_ADDRESS not set"
)

const DVP_ASSETS_VALIDATOR_ADDRESS = makeShelleyAddress(
    DVP_ASSETS_VALIDATOR_ADDRESS_STRING
)

const IS_MAINNET = DVP_ASSETS_VALIDATOR_ADDRESS.mainnet

const COINBASE_API_BASE = "https://api.coinbase.com/v2"

// Precision factor for prices stored in the StateDatum (10,000 = 4 decimal places)
const PRICE_PRECISION = 10_000

// The asset being priced in the StateDatum (ADA/USD)
const PRICED_ASSET = "ADA"

// ============================================================================
// Types
// ============================================================================

type ValidationRequest = {
    kind: "price-update"
    tx: string
}

type PriceToValidate = {
    priceUsd: number
    marketId: number
}

// ============================================================================
// Lambda Handler
// ============================================================================

export async function handler(
    event: APIGatewayProxyEventV2,
    _content: any
): Promise<any> {
    try {
        const request: ValidationRequest = JSON.parse(
            expectDefined(event.body, "request body undefined")
        )
        const signature = await validateRequest(request)

        return {
            statusCode: 200,
            headers: {
                "Access-Control-Allow-Origin": "*",
                "Content-Type": "text/plain"
            },
            body: signature
        }
    } catch (e: any) {
        console.error(e.message)
        console.log(e.stack)

        return {
            statusCode: 400,
            headers: {
                "Access-Control-Allow-Origin": "*"
            },
            body: JSON.stringify({
                error: e.message
            })
        }
    }
}

// ============================================================================
// Request Validation
// ============================================================================

async function validateRequest(request: ValidationRequest): Promise<string> {
    switch (request.kind) {
        case "price-update": {
            const tx = decodeTx(request.tx)
            const cardanoClient = await makeCardanoClient()

            const signature = await validatePriceUpdate(tx, cardanoClient)

            return bytesToHex(signature.toCbor())
        }
        default:
            throw new Error(`unhandled validation request kind ${request.kind}`)
    }
}

async function validatePriceUpdate(
    tx: Tx,
    _cardanoClient: BlockfrostV0Client
): Promise<Signature> {
    if (!tx.body.minted.isZero()) {
        throw new Error("unexpected mints/burns")
    }

    await validatePrices(tx)

    return await signCardanoTx(tx)
}

// ============================================================================
// Price Validation
// ============================================================================

async function validatePrices(tx: Tx): Promise<void> {
    const mintedAssetClasses = tx.body.minted.assetClasses.filter(
        (ac) => !ac.isEqual(ADA)
    )

    if (mintedAssetClasses.length !== 0) {
        throw new Error("can't mint while updating price feed")
    }

    const addr = makeShelleyAddress(DVP_ASSETS_VALIDATOR_ADDRESS)

    const stateOutputs = tx.body.outputs.filter((output) =>
        output.address.isEqual(addr)
    )

    if (stateOutputs.length === 0) {
        throw new Error("no outputs found at validator address")
    }

    const validationErrors: Error[] = []
    const validatedPrices: Record<string, number> = {}

    // Fetch Coinbase prices once
    const coinbasePrices = await fetchCoinbasePrices()

    for (const output of stateOutputs) {
        const priceToValidate = extractPriceFromStateDatum(output)

        validateStateDatumPrice(
            coinbasePrices,
            priceToValidate,
            validationErrors,
            validatedPrices
        )
    }

    if (validationErrors.length === 1) {
        throw validationErrors[0]
    } else if (validationErrors.length > 0) {
        throw new Error(validationErrors.map((e) => e.message).join("; "))
    }

    console.log(
        "Validated tx with prices ",
        JSON.stringify(validatedPrices, undefined, 4)
    )
}

/**
 * Extracts price data from the StateDatum structure
 *
 * StateDatum fields (by index):
 *   0: admin (ScriptHash)
 *   1: main_validator_hash (ScriptHash)
 *   2: mint_validator_hash (ScriptHash)
 *   3: current_market_id (Int)
 *   4: old_price (Int)
 *   5: new_price (Int) <- This is what we validate
 *   6: winner (Option<PositionType>)
 *   7: winner_odds (Int)
 *   8: platform_fee (Int)
 *   9: platform_address (Address)
 */
function extractPriceFromStateDatum(output: TxOutput): PriceToValidate {
    if (!output.datum) {
        throw new Error("state output missing datum")
    }

    if (output.datum.kind !== "InlineTxOutputDatum") {
        throw new Error("state output doesn't have an inline datum")
    }

    const stateDatum = expectConstrData(output.datum.data)
    const fields = stateDatum.fields

    if (fields.length < 6) {
        throw new Error(
            `StateDatum has insufficient fields: expected at least 6, got ${fields.length}`
        )
    }

    // Extract current_market_id (index 3)
    const marketId = Number(expectIntData(fields[3]).value)

    // Extract new_price (index 5) - stored in USD with precision 10,000
    const newPriceRaw = Number(expectIntData(fields[5]).value)
    const priceUsd = newPriceRaw / PRICE_PRECISION

    return {
        priceUsd,
        marketId
    }
}

/**
 * Validates the StateDatum price against Coinbase USD price
 */
function validateStateDatumPrice(
    coinbasePrices: Record<string, number>,
    priceToValidate: PriceToValidate,
    validationErrors: Error[],
    validatedPrices: Record<string, number>
): void {
    const { priceUsd, marketId } = priceToValidate

    // coinbasePrices contains "tokens per 1 USD", so we need to invert
    const tokensPerUsd = coinbasePrices[PRICED_ASSET]

    if (
        tokensPerUsd === undefined ||
        tokensPerUsd === null ||
        tokensPerUsd <= 0 ||
        !Number.isFinite(tokensPerUsd)
    ) {
        validationErrors.push(
            new Error(
                `Coinbase price for ${PRICED_ASSET} not available or invalid (got: ${tokensPerUsd})`
            )
        )
        return
    }

    // Convert to USD per token
    const coinbaseUsdPrice = 1 / tokensPerUsd

    // Additional safety check after division
    if (!Number.isFinite(coinbaseUsdPrice) || coinbaseUsdPrice <= 0) {
        validationErrors.push(
            new Error(
                `Failed to compute USD price for ${PRICED_ASSET}: invalid result (${coinbaseUsdPrice})`
            )
        )
        return
    }

    // Validate price is within tolerance
    const relDiff = Math.abs((priceUsd - coinbaseUsdPrice) / coinbaseUsdPrice)

    if (relDiff > MAX_REL_DIFF) {
        validationErrors.push(
            new Error(
                `${PRICED_ASSET} price out of range for market ${marketId}: expected ~$${coinbaseUsdPrice.toFixed(4)}, got $${priceUsd.toFixed(4)} (${(relDiff * 100).toFixed(2)}% diff)`
            )
        )
        return
    }

    validatedPrices[`market_${marketId}`] = priceUsd
    console.log(
        `Validated ${PRICED_ASSET} price for market ${marketId}: $${priceUsd.toFixed(4)} (Coinbase: $${coinbaseUsdPrice.toFixed(4)}, diff: ${(relDiff * 100).toFixed(2)}%)`
    )
}

// ============================================================================
// Coinbase API
// ============================================================================

/**
 * Fetches exchange rates from Coinbase API
 * Returns rates as { BTC: number, ETH: number, ADA: number, ... }
 * where values are tokens per 1 USD
 */
async function fetchCoinbasePrices(): Promise<Record<string, number>> {
    try {
        const response = await fetch(
            `${COINBASE_API_BASE}/exchange-rates?currency=USD`
        )

        if (!response.ok) {
            console.error(
                `Coinbase API error: ${response.status} ${response.statusText}`
            )
            return {}
        }

        const data = await response.json()

        const rates: Record<string, number> = {}
        for (const [symbol, rate] of Object.entries(data.data.rates)) {
            rates[symbol] = parseFloat(rate as string)
        }

        return rates
    } catch (e) {
        console.error("Failed to fetch Coinbase prices:", e)
        return {}
    }
}

// ============================================================================
// Cardano Utilities
// ============================================================================

async function makeCardanoClient(): Promise<BlockfrostV0Client> {
    const networkName: "preprod" | "mainnet" = IS_MAINNET
        ? "mainnet"
        : "preprod"

    return makeBlockfrostV0Client(networkName, BLOCKFROST_API_KEY)
}

async function signCardanoTx(tx: Tx): Promise<Signature> {
    const pk = makeBip32PrivateKey(hexToBytes(PRIVATE_KEY))
    const id = tx.body.hash()
    return pk.sign(id)
}
