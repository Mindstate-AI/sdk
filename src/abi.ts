// ============================================================================
// @mindstate/sdk — Shared Contract ABI
// ============================================================================

/**
 * Human-readable ABI for MindstateToken contracts (ethers v6 format).
 * Shared between MindstateClient and MindstateExplorer.
 */
export const MINDSTATE_ABI = [
  'function publisher() view returns (address)',
  'function head() view returns (bytes32)',
  'function checkpointCount() view returns (uint256)',
  'function getCheckpoint(bytes32 checkpointId) view returns (tuple(bytes32 predecessorId, bytes32 stateCommitment, bytes32 ciphertextHash, string ciphertextUri, bytes32 manifestHash, uint64 publishedAt, uint64 blockNumber))',
  'function getCheckpointIdAtIndex(uint256 index) view returns (bytes32)',
  'function publish(bytes32 stateCommitment, bytes32 ciphertextHash, string ciphertextUri, bytes32 manifestHash, string label) returns (bytes32)',
  'function tagCheckpoint(bytes32 checkpointId, string tag)',
  'function resolveTag(string tag) view returns (bytes32)',
  'function getCheckpointTag(bytes32 checkpointId) view returns (string)',
  'function redeemMode() view returns (uint8)',
  'function redeemCost() view returns (uint256)',
  'function redeem(bytes32 checkpointId)',
  'function hasRedeemed(address account, bytes32 checkpointId) view returns (bool)',
  'function registerEncryptionKey(bytes32 encryptionPublicKey)',
  'function getEncryptionKey(address account) view returns (bytes32)',
  'function updateCiphertextUri(bytes32 checkpointId, string newCiphertextUri)',
  'function transferPublisher(address newPublisher)',
  'function balanceOf(address account) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'event CheckpointPublished(bytes32 indexed checkpointId, bytes32 indexed predecessorId, uint256 indexed index, bytes32 stateCommitment, bytes32 ciphertextHash, string ciphertextUri, bytes32 manifestHash, uint64 timestamp, uint64 blockNumber)',
  'event CheckpointTagged(bytes32 indexed checkpointId, string tag)',
  'event Redeemed(address indexed account, bytes32 indexed checkpointId, uint256 cost)',
  'event EncryptionKeyRegistered(address indexed account, bytes32 encryptionKey)',
  'event CiphertextUriUpdated(bytes32 indexed checkpointId, string oldUri, string newUri)',
  'event PublisherTransferred(address indexed previousPublisher, address indexed newPublisher)',
  'event KeyEnvelopeDelivered(address indexed consumer, bytes32 indexed checkpointId, bytes wrappedKey, bytes24 nonce, bytes32 senderPublicKey)',
  'function deliverKeyEnvelope(address consumer, bytes32 checkpointId, bytes wrappedKey, bytes24 nonce, bytes32 senderPublicKey)',
  'function getKeyEnvelope(address consumer, bytes32 checkpointId) view returns (bytes wrappedKey, bytes24 nonce, bytes32 senderPublicKey)',
  'function hasKeyEnvelope(address consumer, bytes32 checkpointId) view returns (bool)',
] as const;

/** The zero bytes32 constant. */
export const ZERO_BYTES32 = '0x' + '0'.repeat(64);
