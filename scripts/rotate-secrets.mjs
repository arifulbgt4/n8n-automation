import { closeDb, decryptSecret, encryptSecret, query } from "../packages/core/dist/index.js";

const targets=[
  {table:"channel_credentials",key:"id",column:"encrypted_value"},
  {table:"ai_provider_connections",key:"id",column:"encrypted_api_key"},
  {table:"tenant_media_accounts",key:"id",column:"encrypted_api_key"},
  {table:"platform_admins",key:"user_id",column:"mfa_secret_encrypted"},
  {table:"trainer_identities",key:"id",column:"encrypted_identifier"},
];

let rotated=0;
try{
  for(const target of targets){
    const rows=await query(`SELECT ${target.key} AS row_key,${target.column} AS encrypted_value FROM ${target.table} WHERE ${target.column} IS NOT NULL`);
    for(const row of rows.rows){
      const plaintext=decryptSecret(row.encrypted_value);
      const encrypted=encryptSecret(plaintext);
      await query(`UPDATE ${target.table} SET ${target.column}=$2 WHERE ${target.key}=$1`,[row.row_key,encrypted]);
      rotated++;
    }
    console.log(JSON.stringify({table:target.table,rotated:rows.rowCount??0}));
  }
  console.log(JSON.stringify({ok:true,rotated}));
}finally{
  await closeDb();
}
