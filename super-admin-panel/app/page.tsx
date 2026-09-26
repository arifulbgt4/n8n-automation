import Link from "next/link";
import AdminApp from "../components/AdminApp";
import AdminFeatureRoutes from "../components/AdminFeatureRoutes";

export default function Home() {
  return <><AdminApp/><AdminFeatureRoutes/><Link href="/media-plans" style={{position:"fixed",right:24,bottom:78,zIndex:60,padding:"12px 16px",borderRadius:999,background:"#4f46e5",color:"white",fontWeight:800,textDecoration:"none",boxShadow:"0 12px 30px rgba(79,70,229,.22)"}}>Media limits</Link><Link href="/platform-ai" style={{position:"fixed",right:24,bottom:24,zIndex:60,padding:"12px 16px",borderRadius:999,background:"#111827",color:"white",fontWeight:800,textDecoration:"none",boxShadow:"0 12px 30px rgba(15,23,42,.22)"}}>Platform AI</Link></>;
}
