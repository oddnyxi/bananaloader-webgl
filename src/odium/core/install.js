import { Container } from './Container.js';
import * as components from '../components/index.js';

// Mix every create*() component into Container (and therefore Tab, Group, Column, ...).
// Done here instead of inside Container.js so components may import Container without a cycle.
Object.assign(Container.prototype, components);
