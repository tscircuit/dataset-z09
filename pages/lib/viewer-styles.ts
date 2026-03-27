import type { CSSProperties } from "react";

export const pageStyle: CSSProperties = {
  minHeight: "100vh",
  padding: 24,
  background:
    "linear-gradient(180deg, #f4efe8 0%, #efe7dc 42%, #e4ddd4 100%)",
  color: "#1f2933",
  fontFamily: '"Space Grotesk", "Avenir Next", sans-serif',
};

export const shellStyle: CSSProperties = {
  maxWidth: 1380,
  margin: "0 auto",
  display: "grid",
  gap: 18,
};

export const heroStyle: CSSProperties = {
  borderRadius: 24,
  padding: 24,
  background: "rgba(255, 251, 245, 0.92)",
  border: "1px solid rgba(52, 73, 94, 0.12)",
  boxShadow: "0 24px 60px rgba(66, 52, 35, 0.12)",
};

export const heroHeaderStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  justifyContent: "space-between",
  gap: 16,
  alignItems: "flex-start",
};

export const eyebrowStyle: CSSProperties = {
  fontSize: 12,
  letterSpacing: "0.18em",
  textTransform: "uppercase",
  color: "#7c5c45",
  marginBottom: 10,
};

export const titleStyle: CSSProperties = {
  margin: 0,
  fontSize: "clamp(30px, 5vw, 52px)",
  lineHeight: 0.95,
};

export const descriptionStyle: CSSProperties = {
  margin: "12px 0 0",
  maxWidth: 780,
  color: "#5d4d40",
  lineHeight: 1.55,
};

export const controlsRowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 10,
};

export const metaGridStyle: CSSProperties = {
  marginTop: 20,
  display: "grid",
  gap: 14,
  gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
};

export const fieldStyle: CSSProperties = {
  display: "grid",
  gap: 8,
  fontSize: 13,
  color: "#6b5a4a",
};

export const inputStyle: CSSProperties = {
  width: "100%",
  borderRadius: 14,
  border: "1px solid rgba(76, 96, 119, 0.24)",
  padding: "12px 14px",
  background: "#fffdf9",
  color: "#1f2933",
  fontSize: 15,
};

export const buttonStyle: CSSProperties = {
  borderRadius: 999,
  border: "1px solid rgba(76, 96, 119, 0.2)",
  background: "#fffaf2",
  color: "#1f2933",
  padding: "10px 16px",
  fontSize: 14,
  cursor: "pointer",
};

export const statCardStyle: CSSProperties = {
  display: "grid",
  gap: 8,
  alignContent: "start",
  padding: 16,
  borderRadius: 18,
  background: "rgba(245, 239, 232, 0.9)",
  border: "1px solid rgba(76, 96, 119, 0.14)",
  color: "#6b5a4a",
};

export const viewerCardStyle: CSSProperties = {
  borderRadius: 24,
  overflow: "hidden",
  background: "rgba(255, 252, 247, 0.96)",
  border: "1px solid rgba(52, 73, 94, 0.12)",
  boxShadow: "0 24px 60px rgba(66, 52, 35, 0.12)",
};

export const viewerGridStyle: CSSProperties = {
  display: "grid",
  gap: 18,
  gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
};

export const viewerPanelHeaderStyle: CSSProperties = {
  display: "grid",
  gap: 6,
  padding: "18px 20px 0",
  color: "#5d4d40",
};

export const viewerPanelTitleStyle: CSSProperties = {
  margin: 0,
  fontSize: 20,
  color: "#1f2933",
};

export const emptyStateStyle: CSSProperties = {
  minHeight: "100vh",
  display: "grid",
  placeItems: "center",
  background:
    "radial-gradient(circle at top, #f2dcc1 0%, #f9f4ea 48%, #efe6d8 100%)",
  color: "#2f1f15",
  fontFamily: '"Space Grotesk", "Avenir Next", sans-serif',
};
