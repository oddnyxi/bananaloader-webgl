/** A set of groups where opening one collapses the others. */
export function createAccordion() {
  const list = [];
  return {
    sections: list,
    addSection: (title, o = {}) => {
      const g = this.createGroup(title, { ...o, collapsed: o.collapsed ?? list.length > 0 });
      g._acc = list;
      list.push(g);
      return g;
    },
  };
}
