import { Route, Routes } from "react-router-dom";
import { Home } from "./pages/Home";
import { GuestJoin } from "./pages/GuestJoin";
import { Studio } from "./pages/Studio";
import { Probe } from "./pages/Probe";
import { Bench } from "./pages/Bench";
import { EgressTemplate } from "./pages/EgressTemplate";
import { Perf } from "./pages/Perf";

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/join/:id" element={<GuestJoin />} />
      <Route path="/studio/:id" element={<Studio />} />
      {import.meta.env.DEV ? (
        <>
          <Route path="/internal/probe" element={<Probe />} />
          <Route path="/internal/bench" element={<Bench />} />
        </>
      ) : null}
      <Route path="/internal/perf" element={<Perf />} />
      <Route path="/egress-template" element={<EgressTemplate />} />
    </Routes>
  );
}
