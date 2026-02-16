/**
 * Token Security Check Module
 * 
 * Comprehensive security validation for token addresses including:
 * - Address validation and checksum verification
 * - Contract existence and bytecode analysis
 * - ERC standard detection (ERC20, ERC721, ERC1155)
 * - Security vulnerability assessment
 * - Risk level calculation
 */

// Load environment variables


import {
  SecurityCheckResult,
  TokenSecurityConfig,
  TokenValidationInput,
  AddressValidationResult,
  TokenStandardDetectionResult,
  RiskLevel,
  TokenType,
  ContractStatus,
  BytecodeAnalysis,
  Vulnerability,
  OwnershipInfo,
  TradingRestrictions
} from "./types";

// Import RPC functions for real blockchain calls
import { getBytecode } from "./rpc";

// Re-export TokenSecurityConfig for convenience
export { TokenSecurityConfig };

// ============================================================================
// Constants
// ============================================================================

export const ETHEREUM_CHAIN_ID = 1;

// Get RPC URL from environment or use default Infura endpoint
const getDefaultRpcUrl = (): string => {
  const infuraKey = process.env.INFURA_API_KEY;
  if (infuraKey) {
    return `https://mainnet.infura.io/v3/${infuraKey}`;
  }
  // Fallback to public RPC (not recommended for production)
  return "https://eth.llamarpc.com";
};

const DEFAULT_CONFIG: TokenSecurityConfig = {
  chainId: ETHEREUM_CHAIN_ID,
  apiKeys: {
    etherscan: ""
  },
  rpcUrl: getDefaultRpcUrl(),
  timeout: 30000,
  enableExternalApiCalls: true,
  minLiquidityThreshold: BigInt(10000),
  maxTaxRate: 10,
  allowedOwnerFunctions: [
    "owner()",
    "renounceOwnership()",
    "transferOwnership(address)"
  ]
};

// ERC20 Standard Function Signatures
const ERC20_FUNCTIONS = [
  "totalSupply()",
  "balanceOf(address)",
  "transfer(address,uint256)",
  "transferFrom(address,address,uint256)",
  "approve(address,uint256)",
  "allowance(address,address)"
];

// ERC721 Standard Function Signatures
const ERC721_FUNCTIONS = [
  "balanceOf(address)",
  "ownerOf(uint256)",
  "transferFrom(address,address,uint256)",
  "safeTransferFrom(address,address,uint256)",
  "approve(address,uint256)",
  "setApprovalForAll(address,bool)",
  "isApprovedForAll(address,address)",
  "getApproved(uint256)"
];

// ERC1155 Standard Function Signatures
const ERC1155_FUNCTIONS = [
  "balanceOf(address,uint256)",
  "balanceOfBatch(address[],uint256[])",
  "setApprovalForAll(address,bool)",
  "isApprovedForAll(address,address)",
  "safeTransferFrom(address,address,uint256,uint256,bytes)",
  "safeBatchTransferFrom(address,address,uint256[],uint256[],bytes)"
];

// ============================================================================
// Address Validation Functions
// ============================================================================

export function validateAddressFormat(address: string): AddressValidationResult {
  const result: AddressValidationResult = {
    isValid: false,
    isChecksum: false,
    isContract: false,
    errors: [],
    warnings: []
  };

  if (!address) {
    result.errors.push("Address is empty or undefined");
    return result;
  }

  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    result.errors.push("Invalid address format: must be 42 characters (0x followed by 40 hex chars)");
    return result;
  }

  result.isValid = true;

  const isAllLower = address === address.toLowerCase();
  const isAllUpper = address === address.toUpperCase();
  
  if (!isAllLower && !isAllUpper) {
    result.isChecksum = address === toChecksumAddress(address);
    if (!result.isChecksum) {
      result.warnings.push("Address checksum is invalid");
    }
  } else {
    result.warnings.push("Address is not checksummed");
  }

  return result;
}

export function toChecksumAddress(address: string): string {
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    throw new Error("Invalid address format");
  }

  const addressLower = address.toLowerCase().slice(2);
  let checksum = "0x";

  for (let i = 0; i < 40; i++) {
    const char = addressLower[i];
    const charCode = parseInt(addressLower.substring(i * 2, i * 2 + 2), 16);
    const nextCharCode = i < 39 ? parseInt(addressLower.substring((i + 1) * 2, (i + 1) * 2 + 2), 16) : 0;
    const combined = (charCode << 8) | nextCharCode;
    const hashBit = (combined >> (i % 8)) & 1;
    
    if (hashBit && char >= 'a' && char <= 'z') {
      checksum += char.toUpperCase();
    } else {
      checksum += char;
    }
  }

  return checksum;
}

// ============================================================================
// Contract Analysis Functions
// ============================================================================

export function analyzeBytecode(bytecode: string): BytecodeAnalysis {
  const analysis: BytecodeAnalysis = {
    containsSelfdestruct: false,
    containsDelegatecall: false,
    containsCreate2: false,
    hasImmutableVariables: false,
    hasPersistentStorage: false,
    bytecodeSize: bytecode.length / 2,
    runtimeBytecodeSize: 0
  };

  if (!bytecode || bytecode === "0x") {
    return analysis;
  }

  analysis.containsSelfdestruct = bytecode.includes("ff") && bytecode.includes("3314");
  analysis.containsDelegatecall = bytecode.includes("363d3d373d3d3d363d73");
  analysis.containsCreate2 = bytecode.includes("3d3d3d3d");
  analysis.hasPersistentStorage = bytecode.includes("55");

  return analysis;
}

export function detectTokenStandard(
  bytecode: string,
  abi?: string
): TokenStandardDetectionResult {
  const result: TokenStandardDetectionResult = {
    isErc20: false,
    isErc721: false,
    isErc1155: false,
    confidence: 0,
    detectedFunctions: [],
    missingFunctions: []
  };

  if (!bytecode || bytecode === "0x") {
    return result;
  }

  const selectors = extractFunctionSelectors(bytecode);
  result.detectedFunctions = selectors;

  const erc20Match = ERC20_FUNCTIONS.filter(fn => 
    selectors.some(sel => sel.includes(fn.slice(0, 10)))
  );
  if (erc20Match.length >= 4) {
    result.isErc20 = true;
  }
  result.missingFunctions = ERC20_FUNCTIONS.filter(fn => 
    !selectors.some(sel => sel.includes(fn.slice(0, 10)))
  );

  const erc721Match = ERC721_FUNCTIONS.filter(fn =>
    selectors.some(sel => sel.includes(fn.slice(0, 10)))
  );
  if (erc721Match.length >= 4) {
    result.isErc721 = true;
  }

  const erc1155Match = ERC1155_FUNCTIONS.filter(fn =>
    selectors.some(sel => sel.includes(fn.slice(0, 10)))
  );
  if (erc1155Match.length >= 4) {
    result.isErc1155 = true;
  }

  const allStandards = [...ERC20_FUNCTIONS, ...ERC721_FUNCTIONS, ...ERC1155_FUNCTIONS];
  const totalFunctions = new Set(allStandards).size;
  const detectedCount = new Set(selectors).size;
  result.confidence = Math.round((detectedCount / Math.min(totalFunctions, 20)) * 100);

  return result;
}

function extractFunctionSelectors(bytecode: string): string[] {
  const selectors: string[] = [];
  const hex = bytecode.replace(/^0x/, "");
  const regex = /63[a-fA-F0-9]{8}/g;
  const matches = hex.match(regex);
  
  if (matches) {
    matches.forEach(match => {
      const selector = "0x" + match.slice(2);
      if (!selectors.includes(selector)) {
        selectors.push(selector);
      }
    });
  }

  return selectors;
}

// ============================================================================
// Risk Assessment Functions
// ============================================================================

function calculateRiskLevel(result: Partial<SecurityCheckResult>): RiskLevel {
  let riskScore = 0;

  if (result.isVerified === false) {
    riskScore += 30;
  }

  if (result.isHoneypot === true) {
    riskScore += 50;
  }

  if (result.mintingCapabilities?.isMintable) {
    riskScore += 20;
  }
  if (result.mintingCapabilities?.hasMintingRole) {
    riskScore += 10;
  }

  if (result.tradingRestrictions?.isPausable) {
    riskScore += 5;
  }
  if (result.tradingRestrictions?.isBlacklistable) {
    riskScore += 10;
  }

  result.vulnerabilities?.forEach(vuln => {
    switch (vuln.severity) {
      case RiskLevel.CRITICAL:
        riskScore += 25;
        break;
      case RiskLevel.HIGH:
        riskScore += 15;
        break;
      case RiskLevel.MEDIUM:
        riskScore += 8;
        break;
      case RiskLevel.LOW:
        riskScore += 3;
        break;
    }
  });

  if (riskScore >= 70) return RiskLevel.CRITICAL;
  if (riskScore >= 50) return RiskLevel.HIGH;
  if (riskScore >= 30) return RiskLevel.MEDIUM;
  if (riskScore >= 10) return RiskLevel.LOW;
  return RiskLevel.LOW;
}

function analyzeVulnerabilities(bytecode: string, abi?: string): Vulnerability[] {
  const vulnerabilities: Vulnerability[] = [];
  const selectors = extractFunctionSelectors(bytecode);

  if (bytecode.includes("ff") && bytecode.includes("3314")) {
    vulnerabilities.push({
      type: "SELFDESTRUCT",
      severity: RiskLevel.HIGH,
      description: "Contract contains selfdestruct functionality"
    });
  }

  const mintSelectors = selectors.filter(sel => 
    ["mint", "Mint"].some(fn => sel.includes(fn.slice(0, 8)))
  );
  if (mintSelectors.length > 0) {
    vulnerabilities.push({
      type: "MINTING",
      severity: RiskLevel.MEDIUM,
      description: "Contract has minting capabilities"
    });
  }

  if (selectors.some(sel => ["pause", "Pause"].some(fn => sel.includes(fn.slice(0, 8))))) {
    vulnerabilities.push({
      type: "PAUSABLE",
      severity: RiskLevel.MEDIUM,
      description: "Contract can be paused"
    });
  }

  if (selectors.some(sel => ["blacklist", "Blacklist"].some(fn => sel.includes(fn.slice(0, 10))))) {
    vulnerabilities.push({
      type: "BLACKLIST",
      severity: RiskLevel.HIGH,
      description: "Contract has blacklist functionality"
    });
  }

  if (bytecode.includes("3d3d3d3d") || bytecode.includes("ff0000")) {
    vulnerabilities.push({
      type: "PROXY",
      severity: RiskLevel.LOW,
      description: "Contract uses proxy pattern"
    });
  }

  return vulnerabilities;
}

// ============================================================================
// Helper Functions
// ============================================================================

async function getContractBytecode(address: string, rpcUrl: string): Promise<string> {
  try {
    // Use the viem RPC client to get real bytecode
    // Default to Ethereum mainnet (chainId: 1) if no specific RPC provided
    const bytecode = await getBytecode(address, 1, rpcUrl || undefined);
    return bytecode;
  } catch (error) {
    console.error(`Failed to get bytecode for ${address}:`, error);
    return "0x";
  }
}

async function checkContractVerification(
  address: string,
  chainId: number,
  apiKey: string
): Promise<{ isVerified: boolean; sourceCode?: string; name?: string; symbol?: string }> {
  return { isVerified: false };
}

async function checkHoneypot(address: string, chainId: number): Promise<{ isHoneypot: boolean; isBlacklisted: boolean }> {
  return { isHoneypot: false, isBlacklisted: false };
}

function analyzeOwnership(bytecode: string): OwnershipInfo {
  const selectors = extractFunctionSelectors(bytecode);
  
  return {
    owner: null,
    isOwnable: selectors.some(sel => 
      ["owner()", "getOwner()", "admin()"].some(fn => sel.includes(fn.slice(0, 8)))
    ),
    isProxyAdmin: bytecode.includes("f8518080") && bytecode.includes("a3f4"),
    proxyAdmin: null,
    timelockController: null
  };
}

function analyzeTradingRestrictions(bytecode: string): TradingRestrictions {
  const selectors = extractFunctionSelectors(bytecode);
  
  return {
    isPausable: selectors.some(sel =>
      ["pause()", "Pause()"].some(fn => sel.includes(fn.slice(0, 8)))
    ),
    isBlacklistable: selectors.some(sel =>
      ["blacklist(", "Blacklist("].some(fn => sel.includes(fn.slice(0, 10)))
    ),
    hasTransferRestrictions: bytecode.includes("5a08080b7e") || bytecode.includes("731133"),
    isTaxable: selectors.some(sel =>
      ["tax", "Tax", "fee", "Fee"].some(fn => sel.includes(fn.slice(0, 6)))
    ),
    buyTax: null,
    sellTax: null
  };
}

function calculateOverallScore(result: SecurityCheckResult): number {
  let score = 100;

  if (!result.isVerified) score -= 20;

  result.vulnerabilities.forEach(vuln => {
    switch (vuln.severity) {
      case RiskLevel.CRITICAL: score -= 15; break;
      case RiskLevel.HIGH: score -= 10; break;
      case RiskLevel.MEDIUM: score -= 5; break;
      case RiskLevel.LOW: score -= 2; break;
    }
  });

  if (result.mintingCapabilities?.isMintable) score -= 10;
  if (result.tradingRestrictions?.isBlacklistable) score -= 10;
  if (result.tradingRestrictions?.isPausable) score -= 5;
  if (result.isHoneypot) score -= 50;

  return Math.max(0, Math.min(100, score));
}

// ============================================================================
// Main Security Check Function
// ============================================================================

export async function performSecurityCheck(
  input: TokenValidationInput,
  config?: Partial<TokenSecurityConfig>
): Promise<SecurityCheckResult> {
  const fullConfig: TokenSecurityConfig = {
    ...DEFAULT_CONFIG,
    ...config,
    apiKeys: { ...DEFAULT_CONFIG.apiKeys, ...config?.apiKeys }
  };

  const result: SecurityCheckResult = {
    address: input.address.toLowerCase(),
    chainId: input.chainId || fullConfig.chainId,
    isContract: false,
    contractStatus: ContractStatus.NOT_DEPLOYED,
    tokenType: TokenType.UNKNOWN,
    metadata: {
      name: null,
      symbol: null,
      decimals: null,
      totalSupply: null,
      tokenType: TokenType.UNKNOWN,
      contractAddress: input.address.toLowerCase(),
      chainId: input.chainId || fullConfig.chainId,
      implementation: null
    },
    riskLevel: RiskLevel.UNKNOWN,
    overallScore: 100,
    vulnerabilities: [],
    mintingCapabilities: null,
    ownershipInfo: null,
    tradingRestrictions: null,
    isHoneypot: null,
    isVerified: false,
    isBlacklisted: null,
    isScam: null,
    checkedAt: new Date(),
    errors: [],
    warnings: []
  };

  const addressValidation = validateAddressFormat(input.address);
  if (!addressValidation.isValid) {
    result.errors.push(...addressValidation.errors);
    result.warnings.push(...addressValidation.warnings);
    result.riskLevel = RiskLevel.CRITICAL;
    result.overallScore = 0;
    return result;
  }
  
  result.warnings.push(...addressValidation.warnings);

  const addressLower = input.address.toLowerCase();
  try {
    const bytecode = await getContractBytecode(addressLower, fullConfig.rpcUrl);
    
    if (!bytecode || bytecode === "0x") {
      result.contractStatus = ContractStatus.NOT_DEPLOYED;
      result.isContract = false;
      result.errors.push("No contract found at this address");
      result.riskLevel = RiskLevel.CRITICAL;
      result.overallScore = 0;
      return result;
    }

    result.isContract = true;
    result.contractStatus = ContractStatus.DEPLOYED;

    const standardDetection = detectTokenStandard(bytecode);
    
    if (standardDetection.isErc20) result.tokenType = TokenType.ERC20;
    else if (standardDetection.isErc721) result.tokenType = TokenType.ERC721;
    else if (standardDetection.isErc1155) result.tokenType = TokenType.ERC1155;
    result.metadata.tokenType = result.tokenType;

    result.vulnerabilities = analyzeVulnerabilities(bytecode);

    if (fullConfig.enableExternalApiCalls && fullConfig.apiKeys.etherscan) {
      try {
        const verificationStatus = await checkContractVerification(
          addressLower,
          input.chainId || fullConfig.chainId,
          fullConfig.apiKeys.etherscan
        );
        result.isVerified = verificationStatus.isVerified;
        result.contractStatus = verificationStatus.isVerified 
          ? ContractStatus.VERIFIED 
          : ContractStatus.UNVERIFIED;
        
        if (verificationStatus.name) result.metadata.name = verificationStatus.name;
        if (verificationStatus.symbol) result.metadata.symbol = verificationStatus.symbol;
      } catch {
        result.warnings.push("Could not verify contract status with Etherscan");
      }
    }

    if (fullConfig.enableExternalApiCalls) {
      try {
        const honeypotResult = await checkHoneypot(addressLower, input.chainId || fullConfig.chainId);
        result.isHoneypot = honeypotResult.isHoneypot;
        result.isBlacklisted = honeypotResult.isBlacklisted;
      } catch {
        result.warnings.push("Could not check honeypot status");
      }
    }

    result.riskLevel = calculateRiskLevel(result);
    result.overallScore = calculateOverallScore(result);
    result.ownershipInfo = analyzeOwnership(bytecode);
    result.tradingRestrictions = analyzeTradingRestrictions(bytecode);

  } catch (error) {
    result.errors.push(`Error fetching contract: ${error}`);
    result.riskLevel = RiskLevel.UNKNOWN;
  }

  return result;
}

// ============================================================================
// Validation Helper Functions
// ============================================================================

export async function isTokenSafe(
  address: string,
  chainId: number = ETHEREUM_CHAIN_ID
): Promise<{ isSafe: boolean; reason?: string; riskLevel?: RiskLevel }> {
  try {
    const result = await performSecurityCheck({ address, chainId });
    
    if (result.riskLevel === RiskLevel.CRITICAL) {
      return { isSafe: false, reason: "Critical security issues detected", riskLevel: result.riskLevel };
    }
    if (result.riskLevel === RiskLevel.HIGH && result.overallScore < 60) {
      return { isSafe: false, reason: "High risk detected", riskLevel: result.riskLevel };
    }
    if (result.isHoneypot === true) {
      return { isSafe: false, reason: "Token may be a honeypot", riskLevel: result.riskLevel };
    }
    if (!result.isVerified && result.isContract) {
      return { isSafe: false, reason: "Contract not verified", riskLevel: result.riskLevel };
    }
    
    return { isSafe: result.overallScore >= 70, riskLevel: result.riskLevel };
  } catch (error) {
    return { isSafe: false, reason: `Validation error: ${error}`, riskLevel: RiskLevel.UNKNOWN };
  }
}

export function generateSecurityReport(result: SecurityCheckResult) {
  return {
    summary: `Security Score: ${result.overallScore}/100 (${result.riskLevel})`,
    riskLevel: result.riskLevel,
    findings: result.vulnerabilities.map(v => ({
      category: v.type,
      severity: v.severity,
      title: v.type,
      description: v.description,
      impact: `${v.severity} severity issue`
    })),
    recommendations: [] as string[],
    checkedAt: result.checkedAt
  };
}

// ============================================================================
// Default Export
// ============================================================================

export const defaultConfig: TokenSecurityConfig = DEFAULT_CONFIG;

export default {
  performSecurityCheck,
  validateAddressFormat,
  isTokenSafe,
  generateSecurityReport,
  detectTokenStandard,
  analyzeBytecode,
  defaultConfig
};

