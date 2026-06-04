import React from 'react'
import ReactDOM from 'react-dom/client'
import './theme/tokens.css'
import { ThemeProvider } from './theme/ThemeProvider'
import App from './App'

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </React.StrictMode>,
)
