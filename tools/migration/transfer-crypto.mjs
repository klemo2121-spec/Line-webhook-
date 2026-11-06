import {createHash,createCipheriv,createDecipheriv,publicEncrypt,privateDecrypt,createPublicKey,randomBytes,constants} from 'node:crypto';

export const FORMAT='line-windows-transfer-v1';
export const digest=data=>createHash('sha256').update(data).digest('hex');
export const fingerprint=key=>digest(createPublicKey(key).export({type:'spki',format:'der'}));

export function seal(value,publicKey,expectedFingerprint,sourceBinding){
  if(fingerprint(publicKey)!==expectedFingerprint||!/^[a-f0-9]{64}$/.test(sourceBinding))throw Error('Transfer recipient/source identity does not match');
  const key=randomBytes(32),iv=randomBytes(12);
  try{
    const header={format:FORMAT,recipientFingerprint:expectedFingerprint,sourceBinding,createdAt:new Date().toISOString()};
    const cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from(JSON.stringify(header)));
    const clear=Buffer.from(JSON.stringify(value));
    let ciphertext;try{ciphertext=Buffer.concat([cipher.update(clear),cipher.final()]);}finally{clear.fill(0);}
    return {header,wrappedKey:publicEncrypt({key:publicKey,oaepHash:'sha256',padding:constants.RSA_PKCS1_OAEP_PADDING},key).toString('base64'),iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:ciphertext.toString('base64')};
  }finally{key.fill(0);}
}

export function unseal(envelope,privateKey,expectedSourceBinding){
  if(envelope?.header?.format!==FORMAT||envelope.header.recipientFingerprint!==fingerprint(privateKey)||envelope.header.sourceBinding!==expectedSourceBinding)throw Error('Transfer recipient/source identity does not match');
  if(['wrappedKey','iv','tag','ciphertext'].some(k=>typeof envelope[k]!=='string'||envelope[k].length>131072||!/^[A-Za-z0-9+/]+={0,2}$/.test(envelope[k])))throw Error('Invalid transfer envelope');
  const iv=Buffer.from(envelope.iv,'base64'),tag=Buffer.from(envelope.tag,'base64');
  if(iv.length!==12||tag.length!==16)throw Error('Invalid transfer envelope');
  const key=privateDecrypt({key:privateKey,oaepHash:'sha256',padding:constants.RSA_PKCS1_OAEP_PADDING},Buffer.from(envelope.wrappedKey,'base64'));
  try{
    if(key.length!==32)throw Error('Invalid transfer key');
    const cipher=createDecipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from(JSON.stringify(envelope.header)));cipher.setAuthTag(tag);
    const clear=Buffer.concat([cipher.update(Buffer.from(envelope.ciphertext,'base64')),cipher.final()]);
    try{return JSON.parse(clear.toString('utf8'));}finally{clear.fill(0);}
  }finally{key.fill(0);}
}
