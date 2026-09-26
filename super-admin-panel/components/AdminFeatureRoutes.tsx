"use client";

import { useEffect } from "react";

export default function AdminFeatureRoutes(){
  useEffect(()=>{
    const reconcile=()=>{
      document.querySelectorAll<HTMLButtonElement>("button").forEach((button)=>{
        const text=(button.textContent||"").replace(/\s+/g," ").trim();
        const target=(text==="AI Registry / Templates"||text.endsWith("AI Registry / Templates"))?"/platform-ai":null;
        if(target&&button.dataset.adminFeatureRoute!==target){
          button.dataset.adminFeatureRoute=target;
          button.addEventListener("click",(event)=>{
            event.preventDefault();
            event.stopImmediatePropagation();
            window.location.assign(target);
          },{capture:true});
        }
      });
    };
    reconcile();
    const observer=new MutationObserver(reconcile);
    observer.observe(document.body,{childList:true,subtree:true});
    return()=>observer.disconnect();
  },[]);
  return null;
}
