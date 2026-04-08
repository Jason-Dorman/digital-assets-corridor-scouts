/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    screens: {
      xs: '375px',
      sm: '640px',
      md: '768px',
      lg: '1024px',
      xl: '1280px',
      '2xl': '1536px',
    },
    extend: {
      colors: {
        // Deep purple backgrounds
        void: {
          DEFAULT: '#0d0a1a',
          deep: '#06040d',
          card: '#151029',
          hover: '#1c1535',
        },
        // Purple borders & mid-tones
        ridge: {
          DEFAULT: '#2a2045',
          bright: '#3d2e6b',
          glow: '#7c5cbf',
        },
        // Gold accent palette
        gold: {
          dim: '#8b7a3a',
          DEFAULT: '#c9a227',
          bright: '#f0d060',
          text: '#d4af37',
        },
        // Radar cyan for data/healthy states
        radar: {
          dim: '#0097a7',
          DEFAULT: '#00cfe8',
          bright: '#00e5ff',
        },
        // Lavender for muted text
        lavender: {
          DEFAULT: '#9f8fc7',
          dim: '#6e5f8f',
        },
      },
      boxShadow: {
        'glow-gold': '0 0 12px rgba(201, 162, 39, 0.25)',
        'glow-gold-sm': '0 0 6px rgba(201, 162, 39, 0.15)',
        'glow-radar': '0 0 12px rgba(0, 207, 232, 0.2)',
        'glow-red': '0 0 12px rgba(255, 61, 61, 0.25)',
        'glow-purple': '0 0 20px rgba(124, 92, 191, 0.15)',
      },
      backgroundImage: {
        'grid-pattern':
          'linear-gradient(rgba(42, 32, 69, 0.3) 1px, transparent 1px), linear-gradient(90deg, rgba(42, 32, 69, 0.3) 1px, transparent 1px)',
      },
      backgroundSize: {
        grid: '24px 24px',
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'scan': 'scan 4s linear infinite',
        'glow': 'glow 2s ease-in-out infinite alternate',
      },
      keyframes: {
        scan: {
          '0%': { transform: 'translateY(-100%)' },
          '100%': { transform: 'translateY(100%)' },
        },
        glow: {
          '0%': { opacity: '0.4' },
          '100%': { opacity: '1' },
        },
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'Fira Code', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
    },
  },
  plugins: [],
};
