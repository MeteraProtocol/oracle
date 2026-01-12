/**
 * Legacy validation functions for the old datum structure
 * These are kept for reference and potential future use with different datum formats
 *
 * Old Datum Structure (List-based):
 *   List<[AssetClass, Count, [PriceNum, PriceDen], Timestamp]>
 *
 * This file contains:
 * - Minswap pool validation
 * - CoinGecko price validation
 * - RWA (Real World Asset) price validation
 * - Bitcoin/Ethereum wrapped asset validation
 */

import { decodeUtf8, encodeUtf8, hexToBytes } from "@helios-lang/codec-utils"
import {
    AssetClass,
    convertUplcDataToAssetClass,
    makeAssetClass,
    makeShelleyAddress,
    makeValidatorHash,
    MintingPolicyHash,
    TxOutput
} from "@helios-lang/ledger"
import { BlockfrostV0Client, getAssetClassInfo } from "@helios-lang/tx-utils"
import { expectDefined } from "@helios-lang/type-utils"
import { findPool, getAllV2Pools } from "@helios-lang/minswap"
import { expectIntData, expectListData, UplcData } from "@helios-lang/uplc"
import {
    makeBitcoinWalletProvider,
    wrapped_asset,
    account_aggregate,
    makeEthereumERC20AccountProvider
} from "@pbgtoken/rwa-contract"
import { StrictType } from "@helios-lang/contract-utils"
import {
    type BitcoinWalletProvider,
    type EthereumERC20AccountProvider
} from "@pbgtoken/rwa-contract"

// ============================================================================
// Configuration
// ============================================================================

const MAX_REL_DIFF = 0.01 // 1%

// CoinGecko asset mappings
export const COINGECKO_ASSETS: Record<string, { coingeckoId: string }> = {
    SNEK: { coingeckoId: "snek" },
    USDM: { coingeckoId: "usdm-2" },
    WMTX: { coingeckoId: "world-mobile-token" },
    NIGHT: { coingeckoId: "midnight-3" }
}

// Coinbase asset mappings
export const COINBASE_ASSETS: Record<string, { coinbaseSymbol: string }> = {
    BTC: { coinbaseSymbol: "BTC" },
    wBTC: { coinbaseSymbol: "BTC" },
    ETH: { coinbaseSymbol: "ETH" },
    wETH: { coinbaseSymbol: "ETH" },
    ADA: { coinbaseSymbol: "ADA" },
    tADA: { coinbaseSymbol: "ADA" }
}

// ============================================================================
// Types
// ============================================================================

export type OldPriceToValidate = {
    name: string
    assetClass: AssetClass
    price: number
    decimals: number
}

type RWADatumWrappedAsset = StrictType<
    ReturnType<typeof wrapped_asset.$types.State>
>

type RWADatum =
    | StrictType<ReturnType<typeof account_aggregate.$types.State>>
    | RWADatumWrappedAsset

// ============================================================================
// Price Collection (Old Datum Format)
// ============================================================================

/**
 * Collects prices from the old list-based datum format
 */
export async function collectPricesToValidate(
    cardanoClient: BlockfrostV0Client,
    assetGroupOutputs: TxOutput[]
): Promise<
    [Record<string, OldPriceToValidate>, Error[], Record<string, number>]
> {
    const pricesToValidate: Record<string, OldPriceToValidate> = {}
    const validationErrors: Error[] = []
    const prices: Record<string, number> = {}

    for (const output of assetGroupOutputs) {
        if (!output.datum) {
            throw new Error("asset group output missing datum")
        }

        if (output.datum.kind !== "InlineTxOutputDatum") {
            throw new Error("asset group output doesn't have an inline datum")
        }

        const list = expectListData(output.datum.data)

        for (const assetInfo of list.items) {
            const [assetClassData, _countData, priceData, priceTimeStampData] =
                expectListData(assetInfo).items

            const assetClass = convertUplcDataToAssetClass(assetClassData)

            const [priceNum, priceDen] = expectListData(priceData).items

            const priceWithoutDecimals = Number(priceNum) / Number(priceDen)

            const priceTimestamp = Number(
                expectIntData(priceTimeStampData).value
            )

            const { ticker: name, decimals } = await getAssetClassInfo(
                cardanoClient,
                assetClass
            )

            const price = priceWithoutDecimals / Math.pow(10, 6 - decimals)

            prices[name] = price

            if (Math.abs(priceTimestamp - Date.now()) > 5 * 60_000) {
                validationErrors.push(
                    new Error(
                        `invalid ${name} price timestamp ${new Date(priceTimestamp).toLocaleString()}`
                    )
                )
                continue
            }

            pricesToValidate[name] = {
                name,
                assetClass,
                price,
                decimals
            }
        }
    }

    return [pricesToValidate, validationErrors, prices]
}

// ============================================================================
// Minswap Validation
// ============================================================================

export async function tryValidatingWithMinswapPools(
    cardanoClient: BlockfrostV0Client,
    pricesToValidate: Record<string, OldPriceToValidate>,
    validationErrors: Error[]
): Promise<void> {
    if (Object.keys(pricesToValidate).length === 0) {
        return
    }

    const pools = await getAllV2Pools(cardanoClient)

    for (const name in pricesToValidate) {
        const { assetClass, price, decimals } = pricesToValidate[name]

        try {
            const pool = findPool(pools, makeAssetClass("."), assetClass)
            const adaPerAsset = pool.getPrice(6, decimals)

            if (Math.abs((price - adaPerAsset) / adaPerAsset) > MAX_REL_DIFF) {
                validationErrors.push(
                    new Error(
                        `${name} price out of range, expected ~${adaPerAsset.toFixed(6)}, got ${price.toFixed(6)}`
                    )
                )
            }

            delete pricesToValidate[name]
        } catch (e) {
            if (
                e instanceof Error &&
                e.message.toLowerCase().includes("no pools")
            ) {
                console.log(
                    `No minswap pools found for ${name}, verifying using other methods...`
                )
            } else {
                throw e
            }
        }
    }
}

// ============================================================================
// CoinGecko Validation
// ============================================================================

export async function prefetchCoinGeckoPricesAndRWAMetadata(
    cardanoClient: BlockfrostV0Client,
    pricesToValidate: Record<string, OldPriceToValidate>,
    isMainnet: boolean
): Promise<[Record<string, Record<string, number>>, Record<string, RWADatum>]> {
    const coinGeckoIDs: Set<string> = new Set(["cardano"])
    const rwas: Record<string, RWADatum> = {}

    for (const name in pricesToValidate) {
        if (name in COINGECKO_ASSETS) {
            coinGeckoIDs.add(COINGECKO_ASSETS[name].coingeckoId)
        } else {
            const { assetClass } = pricesToValidate[name]
            const metadata = await getRWAMetadata(
                cardanoClient,
                assetClass,
                isMainnet
            )

            rwas[name] = metadata
            coinGeckoIDs.add(getRWACoinGeckoID(metadata, assetClass))
        }
    }

    const coinGeckoResponse = await fetch(
        `https://api.coingecko.com/api/v3/simple/price?ids=${Array.from(coinGeckoIDs).join("%2C")}&vs_currencies=usd`
    )

    const responseObj = await coinGeckoResponse.json()

    return [responseObj, rwas]
}

export function validateCoinGeckoPrices(
    coinGeckoPrices: Record<string, Record<string, number>>,
    pricesToValidate: Record<string, OldPriceToValidate>,
    validationErrors: Error[]
): void {
    for (const name in pricesToValidate) {
        const { price } = pricesToValidate[name]

        if (name in COINGECKO_ASSETS) {
            validateCoinGeckoPrice(
                coinGeckoPrices,
                name,
                price,
                validationErrors
            )
            delete pricesToValidate[name]
        }
    }
}

function validateCoinGeckoPrice(
    coinGeckoPrices: Record<string, Record<string, number>>,
    name: string,
    price: number,
    validationErrors: Error[]
) {
    const { coingeckoId } = COINGECKO_ASSETS[name]

    const usdPerAda = coinGeckoPrices.cardano.usd
    const usdPerToken = coinGeckoPrices[coingeckoId].usd
    const adaPerToken = usdPerToken / usdPerAda

    if (Math.abs((price - adaPerToken) / adaPerToken) > MAX_REL_DIFF) {
        validationErrors.push(
            new Error(
                `${name} price out of range, expected ~${adaPerToken.toFixed(6)}, got ${price.toFixed(6)}`
            )
        )
    }
}

// ============================================================================
// Coinbase Validation (Old Format)
// ============================================================================

export function validateCoinbasePricesOld(
    coinbasePrices: Record<string, number>,
    pricesToValidate: Record<string, OldPriceToValidate>,
    validationErrors: Error[]
): void {
    const adaPerUsd = coinbasePrices["ADA"]
    if (!adaPerUsd || adaPerUsd <= 0) {
        console.log(
            "Coinbase ADA rate not available, skipping Coinbase validation"
        )
        return
    }

    for (const name in pricesToValidate) {
        if (name in COINBASE_ASSETS) {
            const { coinbaseSymbol } = COINBASE_ASSETS[name]
            const tokenPerUsd = coinbasePrices[coinbaseSymbol]

            if (!tokenPerUsd || tokenPerUsd <= 0) {
                console.log(
                    `Coinbase rate for ${coinbaseSymbol} not available, skipping`
                )
                continue
            }

            const { price } = pricesToValidate[name]
            const adaPerToken = adaPerUsd / tokenPerUsd

            if (Math.abs((price - adaPerToken) / adaPerToken) > MAX_REL_DIFF) {
                validationErrors.push(
                    new Error(
                        `${name} price out of range (Coinbase), expected ~${adaPerToken.toFixed(6)}, got ${price.toFixed(6)}`
                    )
                )
            }

            delete pricesToValidate[name]
            console.log(
                `Validated ${name} price using Coinbase: ${price.toFixed(6)} ADA (expected ~${adaPerToken.toFixed(6)})`
            )
        }
    }
}

// ============================================================================
// RWA (Real World Asset) Validation
// ============================================================================

export async function validateRWAPrices(
    coinGeckoPrices: Record<string, Record<string, number>>,
    rwas: Record<string, RWADatum>,
    pricesToValidate: Record<string, OldPriceToValidate>,
    validationErrors: Error[]
): Promise<void> {
    for (const name in pricesToValidate) {
        const { price, assetClass } = pricesToValidate[name]

        if (name in rwas) {
            const rwa = rwas[name]

            await validateRWAPrice(
                coinGeckoPrices,
                rwa,
                assetClass,
                price,
                validationErrors
            )

            delete pricesToValidate[name]
        }
    }
}

async function validateRWAPrice(
    coinGeckoPrices: Record<string, Record<string, number>>,
    metadata: RWADatum,
    assetClass: AssetClass,
    price: number,
    validationErrors: Error[]
) {
    switch (metadata.type) {
        case "WrappedAsset":
            if (!("venue" in metadata)) {
                throw new Error(
                    `venue not specified in metadata of ${assetClass.toString()}`
                )
            }

            switch (metadata.venue) {
                case "Bitcoin":
                    await validateBitcoinRWAPrices(
                        coinGeckoPrices,
                        assetClass,
                        metadata,
                        price,
                        validationErrors
                    )
                    break
                case "Ethereum":
                    await validateEthereumRWAPrices(
                        coinGeckoPrices,
                        assetClass,
                        metadata,
                        price,
                        validationErrors
                    )
                    break
                default:
                    throw new Error(
                        `unhandled venue '${metadata.venue}' for RWA ${assetClass.toString()}`
                    )
            }
            break
        default:
            throw new Error(
                `only WrappedAsset RWA's supported, got ${metadata.type} for ${assetClass.toString()}`
            )
    }
}

function getRWACoinGeckoID(rwa: RWADatum, assetClass: AssetClass): string {
    switch (rwa.type) {
        case "WrappedAsset":
            if (!("venue" in rwa)) {
                throw new Error(
                    `venue not specified in metadata of ${assetClass.toString()}`
                )
            }

            switch (rwa.venue) {
                case "Bitcoin":
                    switch (rwa.policy) {
                        case "Native":
                            return "bitcoin"
                        default:
                            throw new Error(
                                `unhandled policy '${rwa.policy}' for Bitcoin RWA ${assetClass.toString()}`
                            )
                    }
                case "Ethereum":
                    switch (rwa.policy) {
                        case "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48":
                            return "usd-coin"
                        case "0x45804880De22913dAFE09f4980848ECE6EcbAf78":
                            return "pax-gold"
                        default:
                            throw new Error(
                                `unhandled policy '${rwa.policy}' for RWA ${assetClass.toString()}`
                            )
                    }
                default:
                    throw new Error(
                        `unhandled venue '${rwa.venue}' for RWA ${assetClass.toString()}`
                    )
            }
        default:
            throw new Error(
                `only WrappedAsset RWA's supported, got ${rwa.type} for ${assetClass.toString()}`
            )
    }
}

// ============================================================================
// Ethereum RWA Validation
// ============================================================================

async function validateEthereumRWAPrices(
    coinGeckoPrices: Record<string, Record<string, number>>,
    assetClass: AssetClass,
    metadata: RWADatumWrappedAsset,
    price: number,
    validationErrors: Error[]
) {
    const provider = makeEthereumERC20AccountProvider(
        metadata.account,
        undefined as any,
        "",
        metadata.policy as `0x${string}`
    ) as EthereumERC20AccountProvider

    const reserves = await provider.getInternalBalance()

    switch (metadata.policy) {
        case "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48": // USDC
            validateWrappedTokenPriceWithCoingecko(
                coinGeckoPrices,
                "usd-coin",
                metadata,
                reserves,
                6,
                price,
                validationErrors
            )
            break
        case "0x45804880De22913dAFE09f4980848ECE6EcbAf78": // PAXG
            validateWrappedTokenPriceWithCoingecko(
                coinGeckoPrices,
                "pax-gold",
                metadata,
                reserves,
                18,
                price,
                validationErrors
            )
            break
        default:
            throw new Error(
                `unhandled policy '${metadata.policy}' for RWA ${assetClass.toString()}`
            )
    }
}

// ============================================================================
// Bitcoin RWA Validation
// ============================================================================

async function validateBitcoinRWAPrices(
    coinGeckoPrices: Record<string, Record<string, number>>,
    assetClass: AssetClass,
    metadata: RWADatumWrappedAsset,
    price: number,
    validationErrors: Error[]
) {
    const provider = makeBitcoinWalletProvider(
        metadata.account,
        undefined as any
    )

    switch (metadata.policy) {
        case "Native":
            await validateWrappedBTCPrice(
                provider,
                coinGeckoPrices,
                metadata,
                price,
                validationErrors
            )
            break
        default:
            throw new Error(
                `unhandled policy '${metadata.policy}' for Bitcoin RWA ${assetClass.toString()}`
            )
    }
}

async function validateWrappedBTCPrice(
    provider: BitcoinWalletProvider,
    coinGeckoPrices: Record<string, Record<string, number>>,
    metadata: RWADatumWrappedAsset,
    price: number,
    validationErrors: Error[]
) {
    const reserves = BigInt(await provider.getSats())

    validateWrappedTokenPriceWithCoingecko(
        coinGeckoPrices,
        "bitcoin",
        metadata,
        reserves,
        8,
        price,
        validationErrors
    )
}

function validateWrappedTokenPriceWithCoingecko(
    coinGeckoPrices: Record<string, Record<string, number>>,
    coinGeckoID: string,
    metadata: RWADatumWrappedAsset,
    reserves: bigint,
    reservesDecimals: number,
    price: number,
    validationErrors: Error[]
) {
    const usdPerAda = coinGeckoPrices.cardano.usd
    const usdPerToken = coinGeckoPrices[coinGeckoID].usd
    const adaPerToken = usdPerToken / usdPerAda

    const reservesPrecision = Math.pow(10, reservesDecimals)
    const supplyDecimals = Number(metadata.decimals)
    const supplyPrecision = Math.pow(10, supplyDecimals)

    const nTokenReserves = Number(reserves) / reservesPrecision
    const nTokenSupply = Number(metadata.supply) / supplyPrecision

    let adaPerWrappedToken = adaPerToken

    if (nTokenSupply > 0) {
        const totalValueADA =
            adaPerToken * Math.min(nTokenReserves, nTokenSupply)
        adaPerWrappedToken = totalValueADA / nTokenSupply
    }

    if (
        Math.abs((price - adaPerWrappedToken) / adaPerWrappedToken) >
        MAX_REL_DIFF
    ) {
        validationErrors.push(
            new Error(
                `${metadata.ticker} price out of range, expected ~${adaPerWrappedToken.toFixed(6)}, got ${price.toFixed(6)}`
            )
        )
    }
}

// ============================================================================
// RWA Metadata Helpers
// ============================================================================

function makeRWAMetadataAssetClass(mph: MintingPolicyHash, ticker: string) {
    return makeAssetClass(
        mph,
        hexToBytes("000643b0").concat(encodeUtf8(ticker))
    )
}

function decodeRWADatum(
    ticker: string,
    data: UplcData | undefined,
    isMainnet: boolean
): RWADatum {
    const castDatum = wrapped_asset.$types.Metadata({
        isMainnet
    })
    const datum = expectDefined(data, `not metadata datum for RWA ${ticker}`)

    const state = castDatum.fromUplcData(datum)

    if (state.Cip68.state.type !== "WrappedAsset") {
        throw new Error(`unexpected RWA type ${state.Cip68.state.type}`)
    }

    return state.Cip68.state
}

async function getRWAMetadata(
    cardanoClient: BlockfrostV0Client,
    rwaAssetClass: AssetClass,
    isMainnet: boolean
) {
    const mph = rwaAssetClass.mph
    const tokenName = rwaAssetClass.tokenName

    const ticker = decodeUtf8(tokenName.slice(4))

    const vh = makeValidatorHash(mph.bytes)

    const addr = makeShelleyAddress(isMainnet, vh)

    const metadataAssetClass = makeRWAMetadataAssetClass(mph, ticker)

    const metadataUtxo = expectDefined(
        (
            await cardanoClient.getUtxosWithAssetClass(addr, metadataAssetClass)
        )[0]
    )

    return decodeRWADatum(ticker, metadataUtxo.datum?.data, isMainnet)
}
