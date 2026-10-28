/** /kit/plot.js: d3 and Observable Plot for App pages, as the globals d3 and Plot. */
import * as d3 from 'd3';
import * as Plot from '@observablehq/plot';

Object.assign(window, { d3, Plot });
