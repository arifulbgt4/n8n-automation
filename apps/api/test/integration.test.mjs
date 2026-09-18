import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";

const port=4187;
const base=`http://127.0.0.1:${port}`;
let server;
let serverLog="";

function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
async function waitForServer(){
  const deadline=Date.now()+20_000;
  while(Date.now()<deadline){
    try{const r=await fetch(`${base}/healthz`);if(r.ok)return;}catch{}
    await sleep(150);
  }
  throw new Error(`API did not start. Logs:\n${serverLog}`);
}
function cookieHeader(response){
  const values=typeof response.headers.getSetCookie==="function"
    ? response.headers.getSetCookie()
    : [response.headers.get("set-cookie")].filter(Boolean);
  return values.map(v=>String(v).split(";")[0]).join("; ");
}
async function jsonRequest(path,{method="GET",body,headers={},cookie}={}){
  const response=await fetch(`${base}${path}`,{
    method,
    headers:{
      ...(body!==undefined?{"content-type":"application/json"}:{}),
      ...(cookie?{cookie}:{}),
      ...headers,
    },
    body:body===undefined?undefined:typeof body==="string"?body:JSON.stringify(body),
  });
  const text=await response.text();
  let data;try{data=text?JSON.parse(text):null}catch{data=text}
  return {response,data,cookie:cookieHeader(response)};
}

test("API auth, tenant isolation, CSRF, rate limiting and Meta webhook idempotency",async(t)=>{
  server=spawn(process.execPath,["--import","tsx","src/server.ts"],{
    cwd:process.cwd(),
    env:{
      ...process.env,
      PORT:String(port),
      HOST:"127.0.0.1",
      API_PUBLIC_ORIGIN:base,
      LOG_LEVEL:"error",
      META_APP_SECRET:"integration-meta-secret",
      META_VERIFY_TOKEN:"integration-verify-token",
      AGGREGATION_WINDOW_MS:"500",
    },
    stdio:["ignore","pipe","pipe"],
  });
  server.stdout.on("data",d=>serverLog+=d.toString());
  server.stderr.on("data",d=>serverLog+=d.toString());
  t.after(async()=>{
    if(server&&!server.killed){
      server.kill("SIGTERM");
      await Promise.race([new Promise(r=>server.once("exit",r)),sleep(3000)]);
      if(!server.killed)server.kill("SIGKILL");
    }
  });
  await waitForServer();

  const suffix=`${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
  const password="StrongPass1234";

  const signupA=await jsonRequest("/v1/auth/signup",{method:"POST",body:{
    email:`tenant-a-${suffix}@example.com`,password,name:"Tenant A Owner",organizationName:`Tenant A ${suffix}`
  }});
  assert.equal(signupA.response.status,201,JSON.stringify(signupA.data));
  const tenantA=signupA.data.tenantId;
  const csrfA=signupA.data.csrfToken;
  const cookieA=signupA.cookie;
  assert.ok(tenantA&&csrfA&&cookieA);

  const signupB=await jsonRequest("/v1/auth/signup",{method:"POST",body:{
    email:`tenant-b-${suffix}@example.com`,password,name:"Tenant B Owner",organizationName:`Tenant B ${suffix}`
  }});
  assert.equal(signupB.response.status,201,JSON.stringify(signupB.data));
  const tenantB=signupB.data.tenantId;
  const cookieB=signupB.cookie;

  const business=await jsonRequest(`/v1/tenants/${tenantA}/businesses`,{
    method:"POST",cookie:cookieA,headers:{"x-csrf-token":csrfA},
    body:{name:"Isolation Test Business",timezone:"UTC",currency:"USD",locale:"en"}
  });
  assert.equal(business.response.status,201,JSON.stringify(business.data));
  const businessId=business.data.business.id;

  const ownRead=await jsonRequest(`/v1/tenants/${tenantA}/businesses/${businessId}`,{cookie:cookieA});
  assert.equal(ownRead.response.status,200);

  const crossTenant=await jsonRequest(`/v1/tenants/${tenantA}/businesses/${businessId}`,{cookie:cookieB});
  assert.equal(crossTenant.response.status,404);
  assert.equal(crossTenant.data?.error?.code,"RESOURCE_NOT_FOUND");

  const missingCsrf=await jsonRequest(`/v1/tenants/${tenantA}`,{
    method:"PATCH",cookie:cookieA,body:{name:"Should Not Change"}
  });
  assert.equal(missingCsrf.response.status,403);
  assert.equal(missingCsrf.data?.error?.code,"CSRF_INVALID");

  const channel=await jsonRequest(`/v1/tenants/${tenantA}/channels`,{
    method:"POST",cookie:cookieA,headers:{"x-csrf-token":csrfA},
    body:{
      businessId,platform:"facebook",name:"Integration Page",
      externalAccountId:`page-${suffix}`,testConnection:false,
      credentials:{accessToken:"integration-access-token",appSecret:"integration-channel-secret"}
    }
  });
  assert.equal(channel.response.status,201,JSON.stringify(channel.data));

  const payload={
    object:"page",
    entry:[{
      id:`page-${suffix}`,
      messaging:[{
        sender:{id:`contact-${suffix}`},
        recipient:{id:`page-${suffix}`},
        timestamp:Date.now(),
        message:{mid:`mid-${suffix}`,text:"Hello from webhook integration test"}
      }]
    }]
  };
  const raw=JSON.stringify(payload);

  const badSignature=await jsonRequest("/webhooks/meta",{
    method:"POST",body:raw,headers:{"x-hub-signature-256":"sha256=bad"}
  });
  assert.equal(badSignature.response.status,401);
  assert.equal(badSignature.data?.error?.code,"WEBHOOK_SIGNATURE_INVALID");

  const signature=`sha256=${createHmac("sha256","integration-meta-secret").update(raw).digest("hex")}`;
  const firstWebhook=await jsonRequest("/webhooks/meta",{
    method:"POST",body:raw,headers:{"x-hub-signature-256":signature}
  });
  assert.equal(firstWebhook.response.status,200,JSON.stringify(firstWebhook.data));
  assert.equal(firstWebhook.data.received,1);
  assert.equal(firstWebhook.data.results[0].duplicate,false);

  const duplicateWebhook=await jsonRequest("/webhooks/meta",{
    method:"POST",body:raw,headers:{"x-hub-signature-256":signature}
  });
  assert.equal(duplicateWebhook.response.status,200,JSON.stringify(duplicateWebhook.data));
  assert.equal(duplicateWebhook.data.results[0].duplicate,true);

  const badEmail=`rate-limit-${suffix}@example.com`;
  for(let i=0;i<12;i++){
    const attempt=await jsonRequest("/v1/auth/signin",{method:"POST",body:{email:badEmail,password:"wrong"}});
    assert.equal(attempt.response.status,401,`attempt ${i+1}: ${JSON.stringify(attempt.data)}`);
  }
  const limited=await jsonRequest("/v1/auth/signin",{method:"POST",body:{email:badEmail,password:"wrong"}});
  assert.equal(limited.response.status,429,JSON.stringify(limited.data));
  assert.equal(limited.data?.error?.code,"AUTH_RATE_LIMITED");

  const meB=await jsonRequest("/v1/auth/me",{cookie:cookieB});
  assert.equal(meB.response.status,200);
  assert.equal(meB.data.memberships.some(m=>m.tenant_id===tenantA),false);
  assert.equal(meB.data.memberships.some(m=>m.tenant_id===tenantB),true);
});
