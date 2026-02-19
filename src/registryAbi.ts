// ============================================================================
// @mindstate/sdk — MindstateRegistry Contract ABI
// ============================================================================

/**
 * Human-readable ABI for the MindstateRegistry contract (ethers v6 format).
 *
 * The registry is a standalone checkpoint ledger — same cryptographic
 * guarantees as MindstateToken but without the ERC-20, token supply, or
 * burn-to-redeem mechanism.
 */
export const REGISTRY_ABI = [
  // Stream management
  'function createStream(string name, uint8 accessMode) returns (bytes32)',
  'function getStream(bytes32 streamId) view returns (tuple(address publisher, uint8 accessMode, bytes32 head, uint256 checkpointCount, string name))',
  'function streamCount() view returns (uint256)',
  'function getStreamIdAtIndex(uint256 index) view returns (bytes32)',
  'function getPublisherStreams(address publisher) view returns (bytes32[])',
  'function transferPublisher(bytes32 streamId, address newPublisher)',

  // Checkpoint chain
  'function head(bytes32 streamId) view returns (bytes32)',
  'function checkpointCount(bytes32 streamId) view returns (uint256)',
  'function getCheckpoint(bytes32 streamId, bytes32 checkpointId) view returns (tuple(bytes32 predecessorId, bytes32 stateCommitment, bytes32 ciphertextHash, string ciphertextUri, bytes32 manifestHash, uint64 publishedAt, uint64 blockNumber))',
  'function getCheckpointIdAtIndex(bytes32 streamId, uint256 index) view returns (bytes32)',

  // Publishing
  'function publish(bytes32 streamId, bytes32 stateCommitment, bytes32 ciphertextHash, string ciphertextUri, bytes32 manifestHash, string label) returns (bytes32)',

  // Storage migration
  'function updateCiphertextUri(bytes32 streamId, bytes32 checkpointId, string newCiphertextUri)',

  // Tags
  'function tagCheckpoint(bytes32 streamId, bytes32 checkpointId, string tag)',
  'function resolveTag(bytes32 streamId, string tag) view returns (bytes32)',
  'function getCheckpointTag(bytes32 streamId, bytes32 checkpointId) view returns (string)',

  // Access control
  'function addReader(bytes32 streamId, address reader)',
  'function removeReader(bytes32 streamId, address reader)',
  'function addReaders(bytes32 streamId, address[] readers)',
  'function isReader(bytes32 streamId, address account) view returns (bool)',

  // Encryption key registry
  'function registerEncryptionKey(bytes32 encryptionPublicKey)',
  'function getEncryptionKey(address account) view returns (bytes32)',

  // On-chain key envelope delivery
  'function deliverKeyEnvelope(bytes32 streamId, address consumer, bytes32 checkpointId, bytes wrappedKey, bytes24 nonce, bytes32 senderPublicKey)',
  'function getKeyEnvelope(bytes32 streamId, address consumer, bytes32 checkpointId) view returns (bytes wrappedKey, bytes24 nonce, bytes32 senderPublicKey)',
  'function hasKeyEnvelope(bytes32 streamId, address consumer, bytes32 checkpointId) view returns (bool)',

  // Events
  'event StreamCreated(bytes32 indexed streamId, address indexed publisher, string name, uint8 accessMode)',
  'event CheckpointPublished(bytes32 indexed streamId, bytes32 indexed checkpointId, bytes32 indexed predecessorId, uint256 index, bytes32 stateCommitment, bytes32 ciphertextHash, string ciphertextUri, bytes32 manifestHash, uint64 timestamp, uint64 blockNumber)',
  'event CheckpointTagged(bytes32 indexed streamId, bytes32 indexed checkpointId, string tag)',
  'event CiphertextUriUpdated(bytes32 indexed streamId, bytes32 indexed checkpointId, string oldUri, string newUri)',
  'event EncryptionKeyRegistered(address indexed account, bytes32 encryptionKey)',
  'event KeyEnvelopeDelivered(bytes32 indexed streamId, address indexed consumer, bytes32 indexed checkpointId, bytes wrappedKey, bytes24 nonce, bytes32 senderPublicKey)',
  'event ReaderAdded(bytes32 indexed streamId, address indexed reader)',
  'event ReaderRemoved(bytes32 indexed streamId, address indexed reader)',
  'event PublisherTransferred(bytes32 indexed streamId, address indexed previousPublisher, address indexed newPublisher)',
] as const;
