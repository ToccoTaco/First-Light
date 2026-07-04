// Minimal Phase 0 shell. Squads are hardcoded here for now — YAML parsing arrives
// in Phase 2. Real rendering + editing (DHTMLX behind gantt-adapter.ts) is Phase 3.

const SQUADS = [
  { id: "engines", name: "Engines", color: "#D85A30" },
  { id: "fluids", name: "Fluids", color: "#378ADD" },
  { id: "structures", name: "Structures", color: "#1D9E75" },
  { id: "avionics", name: "Avionics", color: "#7F77DD" },
];

export default function App() {
  return (
    <main
      style={{
        fontFamily: "system-ui, sans-serif",
        maxWidth: 720,
        margin: "3rem auto",
        padding: "0 1rem",
      }}
    >
      <h1>First Light — ND Experimental Propulsion</h1>
      <p>Phase 0 skeleton — engine arrives in Phase 1</p>
      <ul style={{ listStyle: "none", padding: 0 }}>
        {SQUADS.map((squad) => (
          <li
            key={squad.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              margin: "0.4rem 0",
            }}
          >
            <span
              aria-hidden
              style={{
                width: 16,
                height: 16,
                borderRadius: 4,
                backgroundColor: squad.color,
                display: "inline-block",
              }}
            />
            {squad.name}
          </li>
        ))}
      </ul>
    </main>
  );
}
