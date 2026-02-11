import { 
  ConsensusAggregationByFields, 
  CronCapability, 
  handler, 
  median, 
  HTTPClient, 
  Runner, 
  type Runtime 
} from "@chainlink/cre-sdk";
import { fetchGasPrices, type Config, type GasPriceData } from "./fetchInfo";

const onCronTrigger = async (runtime: Runtime<Config>): Promise<string> => {
  const httpClient = new HTTPClient();

  const requestFn = httpClient.sendRequest(
    runtime,
    fetchGasPrices,
    ConsensusAggregationByFields<GasPriceData>({
      safeGasPrice: () => median<number>(),
      proposeGasPrice: () => median<number>(),
      fastGasPrice: () => median<number>(),
      baseFee: () => median<number>(),
      lastBlock: () => median<number>(),
    })
  );

  const response = requestFn(runtime.config);
  const result = response.result();

  runtime.log(`Gas Prices Retrieved:`);
  runtime.log(`  Safe Gas Price: ${result.safeGasPrice} Gwei`);
  runtime.log(`  Propose Gas Price: ${result.proposeGasPrice} Gwei`);
  runtime.log(`  Fast Gas Price: ${result.fastGasPrice} Gwei`);
  runtime.log(`  Base Fee: ${result.baseFee} Gwei`);
  runtime.log(`  Last Block: ${result.lastBlock}`);

  return JSON.stringify(result);
};

const initWorkflow = (config: Config) => {
  return [
    handler(
      new CronCapability().trigger({ schedule: config.schedule }), 
      onCronTrigger
    ),
  ];
};

export async function main() {
  const runner = await Runner.newRunner<Config>();
  await runner.run(initWorkflow);
}

main().catch((error: unknown) => {
  console.log("Workflow failed:", error);
  process.exit(1);
});

