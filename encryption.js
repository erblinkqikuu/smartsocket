// SmartSocket Encryption Module - AES-256-GCM with automatic key derivation
import crypto from 'crypto';

class EncryptionManager {
  constructor() {
    this.masterKey = null;
    this.sessionKeys = new Map(); // socketId -> key
    this.algorithm = 'aes-256-gcm';
    this.keyLength = 32; // 256 bits
    this.nonceLength = 12; // 96 bits for GCM
    this.tagLength = 16; // 128 bits
    this.enableEncryption = true;
  }

  // Initialize with master key
  initialize(masterKeyOrPassphrase) {
    if (typeof masterKeyOrPassphrase === 'string') {
      // Derive key from passphrase
      this.masterKey = crypto
        .pbkdf2Sync(masterKeyOrPassphrase, 'smartsocket-salt', 100000, this.keyLength, 'sha256');
    } else if (Buffer.isBuffer(masterKeyOrPassphrase) && masterKeyOrPassphrase.length === this.keyLength) {
      this.masterKey = masterKeyOrPassphrase;
    } else {
      // Generate random key
      this.masterKey = crypto.randomBytes(this.keyLength);
    }
  }

  // Get or create session key for a connection
  getSessionKey(socketId) {
    if (!this.sessionKeys.has(socketId)) {
      // Derive unique key for this session
      const sessionKey = crypto
        .pbkdf2Sync(this.masterKey, socketId, 10000, this.keyLength, 'sha256');
      this.sessionKeys.set(socketId, sessionKey);
    }
    return this.sessionKeys.get(socketId);
  }

  // Clear session key when connection closes
  clearSessionKey(socketId) {
    this.sessionKeys.delete(socketId);
  }

  // Encrypt data with AES-256-GCM
  encrypt(data, socketId) {
    if (!this.enableEncryption || !this.masterKey) {
      return data;
    }

    try {
      const key = this.getSessionKey(socketId);
      const nonce = crypto.randomBytes(this.nonceLength);
      
      // Convert data to buffer if needed
      const dataBuffer = typeof data === 'string' 
        ? Buffer.from(data, 'utf8')
        : Buffer.isBuffer(data) 
          ? data 
          : Buffer.from(JSON.stringify(data), 'utf8');

      // Create cipher
      const cipher = crypto.createCipheriv(this.algorithm, key, nonce);
      
      // Encrypt data
      const encrypted = Buffer.concat([
        cipher.update(dataBuffer),
        cipher.final()
      ]);

      // Get auth tag
      const authTag = cipher.getAuthTag();

      // Return: [nonce + authTag + encrypted]
      return Buffer.concat([nonce, authTag, encrypted]);
    } catch (err) {
      console.error('[SmartSocket Encryption] Encrypt error:', err.message);
      return data;
    }
  }

  // Decrypt data with AES-256-GCM
  decrypt(encryptedData, socketId) {
    if (!this.enableEncryption || !this.masterKey) {
      return encryptedData;
    }

    try {
      const key = this.getSessionKey(socketId);

      // Ensure it's a buffer
      const buffer = Buffer.isBuffer(encryptedData)
        ? encryptedData
        : typeof encryptedData === 'string'
          ? Buffer.from(encryptedData, 'hex')
          : Buffer.from(encryptedData);

      // Extract nonce, authTag, encrypted data
      const nonce = buffer.slice(0, this.nonceLength);
      const authTag = buffer.slice(this.nonceLength, this.nonceLength + this.tagLength);
      const encrypted = buffer.slice(this.nonceLength + this.tagLength);

      // Create decipher
      const decipher = crypto.createDecipheriv(this.algorithm, key, nonce);
      decipher.setAuthTag(authTag);

      // Decrypt
      const decrypted = Buffer.concat([
        decipher.update(encrypted),
        decipher.final()
      ]);

      return decrypted;
    } catch (err) {
      console.error('[SmartSocket Encryption] Decrypt error:', err.message);
      return encryptedData;
    }
  }

  // Encrypt JSON message
  encryptMessage(message, socketId) {
    try {
      const jsonStr = typeof message === 'string' ? message : JSON.stringify(message);
      const encrypted = this.encrypt(jsonStr, socketId);
      // Convert to hex for safe transmission
      return encrypted.toString('hex');
    } catch (err) {
      console.error('[SmartSocket Encryption] Message encryption error:', err);
      return null;
    }
  }

  // Decrypt JSON message
  decryptMessage(encryptedHex, socketId) {
    try {
      const decrypted = this.decrypt(encryptedHex, socketId);
      const jsonStr = decrypted.toString('utf8');
      return JSON.parse(jsonStr);
    } catch (err) {
      console.error('[SmartSocket Encryption] Message decryption error:', err);
      return null;
    }
  }

  // Get master key as hex string (for sharing with clients)
  getMasterKeyHex() {
    return this.masterKey ? this.masterKey.toString('hex') : null;
  }

  // Set master key from hex string
  setMasterKeyHex(hexKey) {
    this.masterKey = Buffer.from(hexKey, 'hex');
  }

  // Disable/enable encryption
  setEnabled(enabled) {
    this.enableEncryption = enabled;
  }

  isEnabled() {
    return this.enableEncryption && !!this.masterKey;
  }
}

export { EncryptionManager };
export default EncryptionManager;
