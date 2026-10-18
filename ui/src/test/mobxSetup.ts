/** Strict mode in tests too, so an unwrapped mutation fails a test instead
 *  of only showing up as a console warning in the running app. */
import { configure } from 'mobx';

configure({ enforceActions: 'observed' });
