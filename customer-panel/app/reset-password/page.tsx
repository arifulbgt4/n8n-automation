"use client";
import {FormEvent,useState} from "react";
import Link from "next/link";
import {api} from "../../lib/api";

export default function ResetPasswordPage(){
 const[password,setPassword]=useState("");const[busy,setBusy]=useState(false);const[message,setMessage]=useState("");const[error,setError]=useState("");
 async function submit(e:FormEvent){e.preventDefault();const token=new URLSearchParams(window.location.search).get("token");if(!token)return setError("Reset token is missing.");setBusy(true);setError("");try{await api("/v1/auth/reset-password",{method:"POST",body:JSON.stringify({token,password})});setMessage("Password updated. Sign in with your new password.");setPassword("");}catch(e){setError(e instanceof Error?e.message:"Password reset failed.");}finally{setBusy(false)}}
 return <main className="auth-shell"><section className="auth-card"><h1>Reset password</h1><form className="stack" onSubmit={submit}><label className="field"><span>New password</span><input type="password" minLength={10} required value={password} onChange={e=>setPassword(e.target.value)}/><small>At least 10 characters with letters and numbers.</small></label>{error&&<div className="alert error">{error}</div>}{message&&<div className="alert success">{message}</div>}<button className="button primary" disabled={busy}>{busy?"Updating…":"Update password"}</button><Link className="link-button" href="/">Back to sign in</Link></form></section></main>
}
