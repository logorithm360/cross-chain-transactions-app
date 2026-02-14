import { HTTPSendRequester } from "@chainlink/cre-sdk";
import z from "zod";

// ============================================================================
// Schemas
// ============================================================================
const gasOracleResponseSchema = z.object({
  status: z.string(),
  message: z.string(),
  result: z.object({
    LastBlock: z.string(),
    SafeGasPrice: z.string(),
    ProposeGasPrice: z.string(),
    FastGasPrice: z.string(),
    suggestBaseFee: z.string(),
    gasUsedRatio: z.string()
  })
});

const configSchema = z.object({
  etherScanUrl: z.string().url(),
  apiKey: z.string(),
  chainid: z.number(),
  module: z.string(),
  action: z.string(),
  schedule: z.string()
});

// ============================================================================
// Types
// ============================================================================
export type Config = z.infer<typeof configSchema>;

export type GasPriceData = {
  safeGasPrice: number;
  proposeGasPrice: number;
  fastGasPrice: number;
  baseFee: number;
  lastBlock: number;
};

// ============================================================================
// Fetch and Parse Gas Prices from Etherscan
// // ============================================================================


export const fetchGasPrices = (sendRequester: HTTPSendRequester, config: Config): GasPriceData => {

  // requesting data from Etherscan
  const request = {
    url: `${config.etherScanUrl}?chainid=${config.chainid}&module=${config.module}&action=${config.action}&apikey=${config.apiKey}`,
    method: "GET" as const,
  }

  // getting result
  const response = sendRequester.sendRequest(request).result();

  // Decode body from bytes to string, then parse JSON
  const bodyText = new TextDecoder().decode(response.body);
  const gasOracleData = gasOracleResponseSchema.parse(JSON.parse(bodyText));

  if (gasOracleData.status !== "1") {
    throw new Error(`Etherscan API error: ${gasOracleData.message}`);
  }

  return {
    safeGasPrice: parseFloat(gasOracleData.result.SafeGasPrice),
    proposeGasPrice: parseFloat(gasOracleData.result.ProposeGasPrice),
    fastGasPrice: parseFloat(gasOracleData.result.FastGasPrice),
    baseFee: parseFloat(gasOracleData.result.suggestBaseFee),
    lastBlock: parseFloat(gasOracleData.result.LastBlock)
  };
}

