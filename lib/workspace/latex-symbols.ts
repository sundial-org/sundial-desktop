// Pure LaTeX symbol palette model (Overleaf-style Ω picker).
//
// Each symbol carries the literal LaTeX command we insert and a Unicode glyph
// used only for the button face. Kept free of React/Monaco so the catalogue
// can be unit-tested and reused by the toolbar's symbol popover.

export type LatexSymbol = {
  /** LaTeX command inserted at the cursor, e.g. `\\alpha`. */
  latex: string;
  /** Unicode glyph shown on the button face, e.g. `α`. */
  glyph: string;
  /** Accessible name / tooltip, e.g. `alpha`. */
  name: string;
};

export type LatexSymbolCategory = {
  id: string;
  label: string;
  symbols: LatexSymbol[];
};

const sym = (latex: string, glyph: string, name: string): LatexSymbol => ({ latex, glyph, name });

export const LATEX_SYMBOL_CATEGORIES: LatexSymbolCategory[] = [
  {
    id: 'greek',
    label: 'Greek',
    symbols: [
      sym('\\alpha', 'α', 'alpha'),
      sym('\\beta', 'β', 'beta'),
      sym('\\gamma', 'γ', 'gamma'),
      sym('\\delta', 'δ', 'delta'),
      sym('\\epsilon', 'ε', 'epsilon'),
      sym('\\varepsilon', 'ε', 'varepsilon'),
      sym('\\zeta', 'ζ', 'zeta'),
      sym('\\eta', 'η', 'eta'),
      sym('\\theta', 'θ', 'theta'),
      sym('\\vartheta', 'ϑ', 'vartheta'),
      sym('\\iota', 'ι', 'iota'),
      sym('\\kappa', 'κ', 'kappa'),
      sym('\\lambda', 'λ', 'lambda'),
      sym('\\mu', 'μ', 'mu'),
      sym('\\nu', 'ν', 'nu'),
      sym('\\xi', 'ξ', 'xi'),
      sym('\\pi', 'π', 'pi'),
      sym('\\rho', 'ρ', 'rho'),
      sym('\\sigma', 'σ', 'sigma'),
      sym('\\tau', 'τ', 'tau'),
      sym('\\upsilon', 'υ', 'upsilon'),
      sym('\\phi', 'φ', 'phi'),
      sym('\\varphi', 'φ', 'varphi'),
      sym('\\chi', 'χ', 'chi'),
      sym('\\psi', 'ψ', 'psi'),
      sym('\\omega', 'ω', 'omega'),
      sym('\\Gamma', 'Γ', 'Gamma'),
      sym('\\Delta', 'Δ', 'Delta'),
      sym('\\Theta', 'Θ', 'Theta'),
      sym('\\Lambda', 'Λ', 'Lambda'),
      sym('\\Xi', 'Ξ', 'Xi'),
      sym('\\Pi', 'Π', 'Pi'),
      sym('\\Sigma', 'Σ', 'Sigma'),
      sym('\\Phi', 'Φ', 'Phi'),
      sym('\\Psi', 'Ψ', 'Psi'),
      sym('\\Omega', 'Ω', 'Omega'),
    ],
  },
  {
    id: 'arrows',
    label: 'Arrows',
    symbols: [
      sym('\\leftarrow', '←', 'leftarrow'),
      sym('\\rightarrow', '→', 'rightarrow'),
      sym('\\leftrightarrow', '↔', 'leftrightarrow'),
      sym('\\Leftarrow', '⇐', 'Leftarrow'),
      sym('\\Rightarrow', '⇒', 'Rightarrow'),
      sym('\\Leftrightarrow', '⇔', 'Leftrightarrow'),
      sym('\\uparrow', '↑', 'uparrow'),
      sym('\\downarrow', '↓', 'downarrow'),
      sym('\\updownarrow', '↕', 'updownarrow'),
      sym('\\mapsto', '↦', 'mapsto'),
      sym('\\longrightarrow', '⟶', 'longrightarrow'),
      sym('\\longleftarrow', '⟵', 'longleftarrow'),
      sym('\\hookrightarrow', '↪', 'hookrightarrow'),
      sym('\\nearrow', '↗', 'nearrow'),
      sym('\\searrow', '↘', 'searrow'),
    ],
  },
  {
    id: 'operators',
    label: 'Operators',
    symbols: [
      sym('\\sum', '∑', 'sum'),
      sym('\\prod', '∏', 'prod'),
      sym('\\int', '∫', 'int'),
      sym('\\oint', '∮', 'oint'),
      sym('\\partial', '∂', 'partial'),
      sym('\\nabla', '∇', 'nabla'),
      sym('\\sqrt{}', '√', 'sqrt'),
      sym('\\infty', '∞', 'infty'),
      sym('\\pm', '±', 'pm'),
      sym('\\mp', '∓', 'mp'),
      sym('\\times', '×', 'times'),
      sym('\\div', '÷', 'div'),
      sym('\\cdot', '⋅', 'cdot'),
      sym('\\ast', '∗', 'ast'),
      sym('\\circ', '∘', 'circ'),
      sym('\\bullet', '∙', 'bullet'),
      sym('\\oplus', '⊕', 'oplus'),
      sym('\\otimes', '⊗', 'otimes'),
    ],
  },
  {
    id: 'relations',
    label: 'Relations',
    symbols: [
      sym('\\leq', '≤', 'leq'),
      sym('\\geq', '≥', 'geq'),
      sym('\\neq', '≠', 'neq'),
      sym('\\approx', '≈', 'approx'),
      sym('\\equiv', '≡', 'equiv'),
      sym('\\sim', '∼', 'sim'),
      sym('\\simeq', '≃', 'simeq'),
      sym('\\cong', '≅', 'cong'),
      sym('\\propto', '∝', 'propto'),
      sym('\\subset', '⊂', 'subset'),
      sym('\\subseteq', '⊆', 'subseteq'),
      sym('\\supset', '⊃', 'supset'),
      sym('\\in', '∈', 'in'),
      sym('\\notin', '∉', 'notin'),
      sym('\\ni', '∋', 'ni'),
      sym('\\perp', '⊥', 'perp'),
      sym('\\parallel', '∥', 'parallel'),
    ],
  },
  {
    id: 'misc',
    label: 'Misc',
    symbols: [
      sym('\\forall', '∀', 'forall'),
      sym('\\exists', '∃', 'exists'),
      sym('\\nexists', '∄', 'nexists'),
      sym('\\neg', '¬', 'neg'),
      sym('\\wedge', '∧', 'wedge'),
      sym('\\vee', '∨', 'vee'),
      sym('\\emptyset', '∅', 'emptyset'),
      sym('\\mathbb{R}', 'ℝ', 'Reals'),
      sym('\\mathbb{N}', 'ℕ', 'Naturals'),
      sym('\\mathbb{Z}', 'ℤ', 'Integers'),
      sym('\\mathbb{Q}', 'ℚ', 'Rationals'),
      sym('\\mathbb{C}', 'ℂ', 'Complex'),
      sym('\\ldots', '…', 'ldots'),
      sym('\\cdots', '⋯', 'cdots'),
      sym('\\therefore', '∴', 'therefore'),
      sym('\\because', '∵', 'because'),
      sym('\\angle', '∠', 'angle'),
      sym('\\degree', '°', 'degree'),
    ],
  },
  {
    id: 'delimiters',
    label: 'Delimiters',
    symbols: [
      sym('\\langle', '⟨', 'langle'),
      sym('\\rangle', '⟩', 'rangle'),
      sym('\\lceil', '⌈', 'lceil'),
      sym('\\rceil', '⌉', 'rceil'),
      sym('\\lfloor', '⌊', 'lfloor'),
      sym('\\rfloor', '⌋', 'rfloor'),
      sym('\\lbrack', '[', 'lbrack'),
      sym('\\rbrack', ']', 'rbrack'),
      sym('\\|', '‖', 'Vert'),
      sym('\\{ \\}', '{ }', 'braces'),
      sym('\\left( \\right)', '( )', 'left-right'),
    ],
  },
  {
    id: 'accents',
    label: 'Accents',
    symbols: [
      sym('\\hat{}', 'x̂', 'hat'),
      sym('\\bar{}', 'x̄', 'bar'),
      sym('\\vec{}', 'x⃗', 'vec'),
      sym('\\tilde{}', 'x̃', 'tilde'),
      sym('\\dot{}', 'ẋ', 'dot'),
      sym('\\ddot{}', 'ẍ', 'ddot'),
      sym('\\overline{}', 'a̅', 'overline'),
      sym('\\underline{}', 'a̲', 'underline'),
      sym('\\overrightarrow{}', 'a⃗', 'overrightarrow'),
    ],
  },
];

/** Flat lookup of every symbol by its LaTeX command, for tests + reuse. */
export const LATEX_SYMBOLS_BY_LATEX: Record<string, LatexSymbol> = Object.fromEntries(
  LATEX_SYMBOL_CATEGORIES.flatMap((category) => category.symbols).map((symbol) => [symbol.latex, symbol]),
);
