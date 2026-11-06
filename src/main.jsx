import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
// src/main.jsx
import './styles/base.css';
import './styles/pantalla-seleccion.css';
import './styles/layout-presentacion.css';
import './styles/sidebar.css';
import './styles/visor.css';
import './styles/badges.css';
import './styles/drive-explorador.css';
import './styles/camara.css';

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
