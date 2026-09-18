import { closePool, decryptSecret, encryptSecret, query } from "../packages/core/dist/index.js";

const targets=[
  {table:"channel_credentials",column:"encrypted_value"},
  {table:"ai_provider_connections",column:"encrypted_api_key"},
  {table:"tenant_media_accounts",column:"encrypted_api_key"},
  {table:"platform_admins",column:"mfa_secret_encrypted"},
  {table:"trainer_identities",column:"encrypted_identifier"},
];

let rotated=0;
try{
  for(const target of targets){
    const rows=await query(`SELECT ctid::text AS row_key,${target.column} AS encrypted_value FROM ${target.table} WHERE ${target.column} IS NOT NULL`);
    for(const row of rows.rows){
      const plaintext=decryptSecret(row.encrypted_value);
      const encrypted=encryptSecret(plaintext);
      await query(`UPDATE ${target.table} SET ${target.column}=$2 WHERE ctid=$1::tid`,[row.row_key,encrypted]);
      rotated++;
    }
    console.log(JSON.stringify({table:target.table,rotated:rows.rowCount??0}));
  }
  console.log(JSON.stringify({ok:true,rotated}));
}finally{
  await closePool();
}
