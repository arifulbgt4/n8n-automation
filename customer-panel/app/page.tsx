import CustomerApp from "../components/CustomerApp";

export default function Home() {
  // CustomerApp owns the auth gate. Keep the route shell empty before auth so
  // feature navigation and dashboard enhancement observers cannot leak public
  // workspace information.
  return <CustomerApp />;
}
