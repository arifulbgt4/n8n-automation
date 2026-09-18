"use client";
import {useEffect,useState} from "react";
import Link from "next/link";
import {api} from "../../lib/api";

export default function VerifyEmailPage(){
 const[state,setState]=useState<"loading"|"success"|"error">("loading");const[message,setMessage]=useState("Verifying your email…");
 useEffect(()=>{const token=new URLSearchParams(window.location.search).get("token");if(!token){setState("error");setMessage("Verification token is missing.");return;}api("/v1/auth/verify-email",{method:"POST",body:JSON.stringify({token})}).then(()=>{setState("success");setMessage("Your email is verified. You can continue to your workspace.");}).catch(e=>{setState("error");setMessage(e instanceof Error?e.message:"Verification failed.");});},[]);
 return <main className="auth-shell"><section className="auth-card"><div className="brand-mark">A</div><h1>Email verification</h1><div className={state==="error"?"alert error":"alert success"}>{message}</div><Link className="button primary" href="/">Open Customer Panel</Link></section></main>
}
