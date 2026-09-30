import test from "node:test";
import assert from "node:assert/strict";

const { buildGroundedCatalogResponse } = await import("../src/catalog-response.ts");

const item = (id,title,assetIds,relevance_score=0) => ({
  id,
  collection_id:"collection-1",
  title,
  data_jsonb:{},
  collection_name:"Sarees",
  purpose:"products",
  relevance_score,
  media:assetIds.map((assetId,displayOrder)=>({
    assetId,
    kind:"image",
    mimeType:"image/jpeg",
    role:displayOrder === 0 ? "primary" : "gallery",
    displayOrder,
  })),
});

test("catalog media responses reject ungrounded assets and de-duplicate model output", () => {
  const items=[item("item-1","Tangail saree",["asset-1","asset-2"])];
  const messages=buildGroundedCatalogResponse({
    rawMessages:[
      {type:"text",text:"Here are the photos."},
      {type:"media",assetId:"not-in-catalog"},
      {type:"media",assetId:"asset-1"},
      {type:"media",assetId:"asset-1"},
    ],
    items,
    explicitMediaRequest:false,
    imageLimit:5,
  });
  assert.deepEqual(messages,[
    {type:"text",text:"Here are the photos."},
    {type:"media",assetId:"asset-1",caption:"Tangail saree"},
  ]);
});

test("an explicit photo request deterministically sends one primary per item before gallery images", () => {
  const items=[
    item("item-1","Tangail saree",["asset-1","asset-2"]),
    item("item-2","Half silk saree",["asset-3","asset-4"]),
  ];
  const messages=buildGroundedCatalogResponse({
    rawMessages:[{type:"text",text:"Available photos"}],
    items,
    explicitMediaRequest:true,
    imageLimit:3,
  });
  assert.deepEqual(messages,[
    {type:"text",text:"Available photos"},
    {type:"media",assetId:"asset-1",caption:"Tangail saree"},
    {type:"media",assetId:"asset-3",caption:"Half silk saree"},
    {type:"media",assetId:"asset-2",caption:"Tangail saree"},
  ]);
});

test("catalog responses honor image and total message limits", () => {
  const messages=buildGroundedCatalogResponse({
    rawMessages:Array.from({length:8},(_,index)=>({type:"text",text:`Text ${index}`})),
    items:[item("item-1","Saree",["asset-1","asset-2","asset-3"])],
    explicitMediaRequest:true,
    imageLimit:2,
    totalMessageLimit:4,
  });
  assert.equal(messages.length,4);
  assert.deepEqual(messages.slice(-2).map(message=>message.assetId),["asset-1","asset-2"]);
});

test("a specific product photo request supplements only the best matching item gallery", () => {
  const messages=buildGroundedCatalogResponse({
    rawMessages:[{type:"text",text:"Tangail photos"}],
    items:[
      item("item-1","Tangail saree",["asset-1","asset-2"],120),
      item("item-2","Half silk saree",["asset-3"],10),
    ],
    explicitMediaRequest:true,
    specificMediaRequest:true,
    imageLimit:5,
  });
  assert.deepEqual(messages.filter(message=>message.type==="media").map(message=>message.assetId),["asset-1","asset-2"]);
});
