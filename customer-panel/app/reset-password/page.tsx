"use client";
import {FormEvent,useRef,useState} from "react";
import Link from "next/link";
import {api} from "../../lib/api";

export default function ResetPasswordPage(){
 const[password,setPassword]=useState("");const[busy,setBusy]=useState(false);const[completed,setCompleted]=useState(false);const[message,setMessage]=useState("");const[error,setError]=useState("");const submitting=useRef(false);
 async function submit(e:FormEvent){
  e.preventDefault();
  if(submitting.current||completed)return;
  const token=new URLSearchParams(window.location.search).get("token");
  if(!token){setMessage("");setError("Reset token is missing.");return;}
  submitting.current=true;setBusy(true);setError("");setMessage("");
  try{await api("/v1/auth/reset-password",{method:"POST",body:JSON.stringify({token,password})});setPassword("");setCompleted(true);setMessage("Password updated. Sign in with your new password.");}
  catch(e){setMessage("");setError(e instanceof Error?e.message:"Password reset failed.");}
  finally{submitting.current=false;setBusy(false);}
 }
 return <main className="auth-shell"><section className="auth-card"><h1>Reset password</h1><form className="stack" onSubmit={submit}><label className="field"><span>New password</span><input type="password" minLength={10} autoComplete="new-password" required value={password} disabled={busy||completed} onChange={e=>setPassword(e.target.value)}/><small>At least 10 characters with letters and numbers.</small></label>{error&&<div className="alert error" role="alert">{error}</div>}{message&&<div className="alert success" role="status">{message}</div>}<button className="button primary" disabled={busy||completed}>{busy?"Updating…":completed?"Password updated":"Update password"}</button><Link className="link-button" href="/">Back to sign in</Link></form></section></main>
}
