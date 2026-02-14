/**
 * Token Security Check Types
 * 
 * Comprehensive type definitions for token address security validation
 */

// ============================================================================
// Risk Assessment Types
// ============================================================================

export enum RiskLevel {
  LOW = "LOW",
  MEDIUM = "MEDIUM",
  HIGH = "HIGH",
  CRITICAL = "CRITICAL",
  UNKNOWN = "UNKNOWN"
}

export enum TokenType {
  ERC20 = "ERC20",
  ERC721 = "ERC721", // NFT
  ERC1155 = "ERC1155", // Multi-token
  UNKNOWN = "UNKNOWN"
}

export enum ContractStatus {
  VERIFIED = "VERIFIED",
  UNVERIFIED = "UNVERIFIED",
  DEPLOYED = "DEPLOYED",
  NOT_DEPLOYED = "NOT_DEPLOYED"
}

// ============================================================================
// Vulnerability Types
// ============================================================================

export interface Vulnerability {
  type: string;
  severity: RiskLevel;
  description: string;
  details?: Record<string, unknown>;
}

export interface MintingCapabilities {
  hasMintingRole: boolean;
  maxSupply: bigint | null;
  totalSupply: bigint | null;
  isMintable: boolean;
  minters: string[];
}

export interface OwnershipInfo {
  owner: string | null;
  isOwnable: boolean;
  isProxyAdmin: boolean;
  proxyAdmin: string | null;
  timelockController: string | null;
}

export interface TradingRestrictions {
  isPausable: boolean;
  isBlacklistable: boolean;
  hasTransferRestrictions: boolean;
  isTaxable: boolean;
  buyTax: number | null;
  sellTax: number | null;
}

export interface TokenMetadata {
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  totalSupply: bigint | null;
  tokenType: TokenType;
  contractAddress: string;
  chainId: number;
  implementation: string | null;
}

// ============================================================================
// Security Check Result
// ============================================================================

export interface SecurityCheckResult {
  // Basic info
  address: string;
  chainId: number;
  isContract: boolean;
  contractStatus: ContractStatus;
  
  // Token info
  tokenType: TokenType;
  metadata: TokenMetadata;
  
  // Security analysis
  riskLevel: RiskLevel;
  overallScore: number; // 0-100, higher is safer
  
  // Detailed findings
  vulnerabilities: Vulnerability[];
  mintingCapabilities: MintingCapabilities | null;
  ownershipInfo: OwnershipInfo | null;
  tradingRestrictions: TradingRestrictions | null;
  
  // External validation
  isHoneypot: boolean | null;
  isVerified: boolean;
  isBlacklisted: boolean | null;
  isScam: boolean | null;
  
  // Metadata
  checkedAt: Date;
  errors: string[];
  warnings: string[];
}

// ============================================================================
// Configuration Types
// ============================================================================

export interface TokenSecurityConfig {
  chainId: number;
  apiKeys: {
    etherscan: string;
    sourcify?: string;
  };
  rpcUrl: string;
  timeout: number; // milliseconds
  enableExternalApiCalls: boolean;
  minLiquidityThreshold: bigint;
  maxTaxRate: number; // percentage
  allowedOwnerFunctions?: string[];
}

export interface TokenValidationInput {
  address: string;
  chainId: number;
  config?: Partial<TokenSecurityConfig>;
}

// ============================================================================
// Analysis Types
// ============================================================================

export interface BytecodeAnalysis {
  containsSelfdestruct: boolean;
  containsDelegatecall: boolean;
  containsCreate2: boolean;
  hasImmutableVariables: boolean;
  hasPersistentStorage: boolean;
  bytecodeSize: number;
  runtimeBytecodeSize: number;
}

export interface FunctionAnalysis {
  isExternal: boolean;
  isPublic: boolean;
  isPayable: boolean;
  selectors: string[];
  signatures: string[];
}

export interface ContractAnalysis {
  bytecode: string;
  runtimeBytecode: string;
  functions: FunctionAnalysis[];
  events: string[];
  errors: string[];
}

// ============================================================================
// API Response Types (Etherscan)
// ============================================================================

export interface EtherscanSourceCodeResponse {
  status: string;
  message: string;
  result: Array<{
    SourceCode: string;
    ABI: string;
    ContractName: string;
    CompilerVersion: string;
    OptimizationUsed: string;
    Runs: string;
    ConstructorArguments: string;
    EVMVersion: string;
    Library: string;
    LicenseType: string;
    Proxy: string;
    Implementation: string;
    SwarmSource: string;
  }>;
}

export interface EtherscanContractStatusResponse {
  status: string;
  message: string;
  result: Array<{
    isErc20: string;
    isErc721: string;
    supportInterface: string;
  }>;
}

// ============================================================================
// Validation Result Types
// ============================================================================

export interface AddressValidationResult {
  isValid: boolean;
  isChecksum: boolean;
  isContract: boolean;
  errors: string[];
  warnings: string[];
}

export interface TokenStandardDetectionResult {
  isErc20: boolean;
  isErc721: boolean;
  isErc1155: boolean;
  confidence: number;
  detectedFunctions: string[];
  missingFunctions: string[];
}

// ============================================================================
// Report Types
// ============================================================================

export interface SecurityReport {
  summary: string;
  riskLevel: RiskLevel;
  findings: SecurityFinding[];
  recommendations: string[];
  checkedAt: Date;
}

export interface SecurityFinding {
  category: string;
  severity: RiskLevel;
  title: string;
  description: string;
  impact: string;
  remediation?: string;
}

