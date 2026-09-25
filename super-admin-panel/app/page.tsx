import Link from "next/link";
import AdminApp from "../components/AdminApp";

export default function Home() {
  return <><AdminApp/><Link href="/platform-ai" style={{position:"fixed",right:24,bottom:24,zIndex:60,padding:"12px 16px",borderRadius:999,background:"#111827",color:"white",fontWeight:800,textDecoration:"none",boxShadow:"0 12px 30px rgba(15,23,42,.22)"}}>Platform AI</Link></>;
}
