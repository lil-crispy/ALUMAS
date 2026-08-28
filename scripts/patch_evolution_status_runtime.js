const fs = require('fs');

const targetPath = '/evolution/dist/api/integrations/channel/whatsapp/whatsapp.baileys.service.js';
const backupPath = `${targetPath}.pre-status-buffer.bak`;

const helperMethod =
  'async prepareStatusImage(e){let t;if((0,z.isURL)(e)){let o={responseType:"arraybuffer"};this.localProxy?.enabled&&(o={...o,httpsAgent:De({host:this.localProxy.host,port:this.localProxy.port,protocol:this.localProxy.protocol,username:this.localProxy.username,password:this.localProxy.password})});let i=await Le.default.get(e,o);t=Buffer.from(i.data,"binary")}else{let o=(0,z.isBase64)(e)?e.replace(/^data:image\\\\/[a-zA-Z0-9.+-]+;base64,/,""):e;t=Buffer.from(o,"base64")}return await(0,dn.default)(t).jpeg().toBuffer()}';

const oldImageBranch =
  'if(e.type==="image")return{content:{image:{url:e.content},caption:e.caption},option:{statusJidList:e.statusJidList}};';

const newImageBranch =
  'if(e.type==="image"){let t=await this.prepareStatusImage(e.content);return{content:{image:t,caption:e.caption,mimetype:"image/jpeg",fileName:"status.jpg"},option:{statusJidList:e.statusJidList,allContacts:e.allContacts}};}';

const oldAllContactsList =
  'e.statusJidList=t.filter(o=>o.pushName).map(o=>o.remoteJid)';

const newAllContactsList =
  'e.statusJidList=t.filter(o=>o.pushName&&typeof o.remoteJid==="string"&&!o.remoteJid.endsWith("@g.us")&&!o.remoteJid.endsWith("@newsletter")&&o.remoteJid!=="status@broadcast").map(o=>o.remoteJid)';

const optionNeedle = 'statusJidList:e.statusJidList}';
const optionReplacement = 'statusJidList:e.statusJidList,allContacts:e.allContacts}';
const oldSendAllContactsFilter = 'remoteJid:{not:{endsWith:"@g.us"}}';
const newSendAllContactsFilter = 'remoteJid:{endsWith:"@s.whatsapp.net"}';
const oldValidatedListBuild =
  'e.statusJidList=t.filter(o=>o.pushName&&typeof o.remoteJid==="string"&&!o.remoteJid.endsWith("@g.us")&&!o.remoteJid.endsWith("@newsletter")&&o.remoteJid!=="status@broadcast").map(o=>o.remoteJid)';
const newValidatedListBuild =
  'e.statusJidList=[...new Set((await this.client.onWhatsApp(...t.filter(o=>o.pushName&&typeof o.remoteJid==="string"&&!o.remoteJid.endsWith("@g.us")&&!o.remoteJid.endsWith("@newsletter")&&o.remoteJid!=="status@broadcast").map(o=>o.remoteJid.replace("+","")))).filter(o=>o?.exists&&typeof o.jid==="string"&&o.jid.endsWith("@s.whatsapp.net")).map(o=>o.jid))]';
const oldSendStatusListSource =
  't.status.option.allContacts?u=(await this.prismaRepository.contact.findMany({where:{instanceId:this.instanceId,remoteJid:{endsWith:"@s.whatsapp.net"}}})).map(w=>w.remoteJid):u=t.status.option.statusJidList';
const newSendStatusListSource =
  'u=t.status.option.statusJidList||[]';
const oldStatusBatchSize =
  'let m=10,d=Array.from({length:Math.ceil(u.length/m)},(S,w)=>u.slice(w*m,w*m+m)),h=null,g,y=d.shift();';
const newStatusBatchSize =
  'let m=5,d=Array.from({length:Math.ceil(u.length/m)},(S,w)=>u.slice(w*m,w*m+m)),h=null,g,y=d.shift();';

let source = fs.readFileSync(targetPath, 'utf8');

if (!fs.existsSync(backupPath)) {
  fs.copyFileSync(targetPath, backupPath);
}

if (!source.includes('async prepareStatusImage(e){')) {
  if (!source.includes('async formatStatusMessage(e){')) {
    throw new Error('No se encontro el marcador async formatStatusMessage(e){');
  }
  source = source.replace('async formatStatusMessage(e){', `${helperMethod}async formatStatusMessage(e){`);
}

if (!source.includes(newImageBranch) && source.includes(oldImageBranch)) {
  source = source.replace(oldImageBranch, newImageBranch);
}

if (source.includes(oldAllContactsList) && !source.includes(newAllContactsList)) {
  source = source.replace(oldAllContactsList, newAllContactsList);
}

if (source.includes(optionNeedle) && !source.includes(optionReplacement)) {
  source = source.replaceAll(optionNeedle, optionReplacement);
}

if (source.includes(oldSendAllContactsFilter) && !source.includes(newSendAllContactsFilter)) {
  source = source.replace(oldSendAllContactsFilter, newSendAllContactsFilter);
}

if (source.includes(oldValidatedListBuild) && !source.includes(newValidatedListBuild)) {
  source = source.replace(oldValidatedListBuild, newValidatedListBuild);
}

if (source.includes(oldSendStatusListSource) && !source.includes(newSendStatusListSource)) {
  source = source.replace(oldSendStatusListSource, newSendStatusListSource);
}

if (source.includes(oldStatusBatchSize) && !source.includes(newStatusBatchSize)) {
  source = source.replace(oldStatusBatchSize, newStatusBatchSize);
}

fs.writeFileSync(targetPath, source, 'utf8');
console.log('Patched Evolution status runtime:', targetPath);
console.log('Backup:', backupPath);
