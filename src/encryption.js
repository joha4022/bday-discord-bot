import crypto from 'crypto';
import { CONFIG } from './config.js';

function getKey() {
  const keyStr = CONFIG.ADDRESS_ENCRYPTION_KEY;
  // Accept hex or base64 or raw 32-byte string
  let key;
  if (/^[0-9a-fA-F]{64}$/.test(keyStr)) {
    key = Buffer.from(keyStr, 'hex');
  } else {
    try {
      key = Buffer.from(keyStr, 'base64');
    } catch {
      key = Buffer.from(keyStr, 'utf8');
    }
  }
  if (key.length !== 32) {
    throw new Error('ADDRESS_ENCRYPTION_KEY must be 32 bytes (hex or base64).');
  }
  return key;
}

const KEY = getKey();
const VERSION = 1;

export function encryptAddress(addressObj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const plaintext = Buffer.from(JSON.stringify(addressObj), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    ciphertext: Buffer.concat([ciphertext, tag]).toString('base64'),
    iv: iv.toString('base64'),
    version: VERSION
  };
}

export function decryptAddress({ ciphertext, iv }) {
  const raw = Buffer.from(ciphertext, 'base64');
  const ivBuf = Buffer.from(iv, 'base64');
  const tag = raw.slice(raw.length - 16);
  const data = raw.slice(0, raw.length - 16);

  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, ivBuf);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(data), decipher.final()]);
  return JSON.parse(plaintext.toString('utf8'));
}
