import test from "node:test";
import assert from "node:assert/strict";
import { normalizeMetaPayload } from "../src/routes/webhooks.ts";
import { inspectNativeTrainingCapability, isNativeHumanReply } from "../src/native-training-capability.ts";
import { groupTrainingEvents } from "../src/training-session.ts";

test("Facebook Page Inbox echo resolves the Page as channel and the recipient as customer", () => {
  const [customer] = normalizeMetaPayload({object:"page",entry:[{id:"page-1",messaging:[{
    sender:{id:"contact-1"},recipient:{id:"page-1"},timestamp:1_700_000_000_000,
    message:{mid:"in-1",text:"Can you help?"},
  }]}]});
  const [owner] = normalizeMetaPayload({object:"page",entry:[{id:"page-1",messaging:[{
    sender:{id:"page-1"},recipient:{id:"contact-1"},timestamp:1_700_000_001_000,
    message:{mid:"out-1",text:"Yes",is_echo:true,app_id:26390203743090},
  }]}]});
  assert.equal(customer.channelExternalId,"page-1");
  assert.equal(customer.senderExternalId,"contact-1");
  assert.equal(owner.channelExternalId,"page-1");
  assert.equal(owner.senderExternalId,"contact-1");
  assert.equal(isNativeHumanReply(customer),false);
  assert.equal(isNativeHumanReply(owner),true);
});

test("an API echo or Instagram echo cannot become a native human training reply", () => {
  const [apiEcho] = normalizeMetaPayload({object:"page",entry:[{id:"page-1",messaging:[{
    sender:{id:"page-1"},recipient:{id:"contact-1"},timestamp:1_700_000_001_000,
    message:{mid:"api-1",text:"Bot reply",is_echo:true,app_id:12345},
  }]}]});
  const [instagramEcho] = normalizeMetaPayload({object:"instagram",entry:[{id:"ig-1",messaging:[{
    sender:{id:"ig-1"},recipient:{id:"contact-2"},timestamp:1_700_000_001_000,
    message:{mid:"ig-echo",text:"Reply",is_echo:true},
  }]}]});
  assert.equal(isNativeHumanReply(apiEcho),false);
  assert.equal(isNativeHumanReply(instagramEcho),false);
});

test("unverified Instagram and WhatsApp channels cannot turn native training on", async () => {
  for (const platform of ["instagram","whatsapp"]) {
    const capability=await inspectNativeTrainingCapability({platform,active:true,connection_status:"connected"});
    assert.equal(capability.supported,false);
    assert.notEqual(capability.status,"ready");
  }
});

test("WhatsApp Business App echo uses smb_message_echoes recipient and excludes edits", () => {
  const messages = normalizeMetaPayload({object:"whatsapp_business_account",entry:[{id:"waba-1",changes:[{
    field:"smb_message_echoes",value:{metadata:{phone_number_id:"phone-1"},message_echoes:[
      {id:"wamid-1",from:"15550000000",to:"+15551111111",timestamp:"1700000000",type:"text",text:{body:"Human reply"}},
      {id:"wamid-2",from:"15550000000",to:"+15551111111",timestamp:"1700000001",type:"edit",edit:{}},
    ]},
  }]}]});
  assert.equal(messages.length,1);
  assert.equal(messages[0].channelExternalId,"phone-1");
  assert.equal(messages[0].senderExternalId,"15551111111");
  assert.equal(messages[0].text,"Human reply");
  assert.equal(isNativeHumanReply(messages[0]),true);
});

test("training pairs use only customer messages and subsequent human replies from the same conversation", () => {
  const event=(id,conversation_id,direction,text_content,time)=>({
    id,conversation_id,direction,text_content,event_at:new Date(`2026-09-28T00:00:0${time}.000Z`),
  });
  const pairs=groupTrainingEvents([
    event("a1","a","CONTACT","First question",1),
    event("b1","b","HUMAN","Orphan reply",1),
    event("a2","a","CONTACT","More detail",2),
    event("a3","a","HUMAN","First answer",3),
    event("a4","a","HUMAN","Second answer",4),
    event("b2","b","CONTACT","Other customer",5),
    event("b3","b","HUMAN","Other answer",6),
  ]);
  assert.equal(pairs.length,2);
  assert.deepEqual(pairs[0].customerEventIds,["a1","a2"]);
  assert.equal(pairs[0].inputText,"First question\nMore detail");
  assert.equal(pairs[0].idealResponse,"First answer\nSecond answer");
  assert.equal(pairs[1].inputEventId,"b2");
  assert.equal(pairs[1].idealResponse,"Other answer");
  assert.equal(groupTrainingEvents([
    event("media","a","CONTACT","",1),
    event("reply","a","HUMAN","Reply without text input",2),
  ]).length,0);
  const alternating=groupTrainingEvents([
    event("r2","a","HUMAN","Second response",4),
    event("q1","a","CONTACT","First request",1),
    event("q2","a","CONTACT","Second request",3),
    event("r1","a","HUMAN","First response",2),
  ]);
  assert.deepEqual(alternating.map(pair=>pair.inputEventId),["q1","q2"]);
});
