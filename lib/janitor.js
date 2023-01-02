export default class Janitor {
  constructor() {
    this.tasks = [];
  }
  
  addTask(task) {
    this.tasks.push(task);
  }
  
  cleanUpSync() {
    const errors = [], tasks = this.tasks.slice();
    this.tasks.splice(0, Infinity);
    while(tasks.length) {
      const task = tasks.pop();
      try {
        task();
      } catch (e) {
        if (e != null) {
          e.task = task;
        }
        errors.push(e);
      }
    }
    this._handleErrors(errors);
  }
  
  async cleanUpAsync() {
    const tasks = this.tasks.slice();
    this.tasks.splice(0, Infinity);
    const errors = (await Promise.allSettled(
      tasks.map(t => t())
    )).flatMap((result, i) => {
      const reason = result.reason;
      
      // intentional loose equality
      if (reason == null) return [];
      
      reason.task = tasks[i];
      return [reason];
    });
    this._handleErrors(errors);
  }
  
  _handleErrors(errors) {
    if (errors.length === 0) {
      // do nothing
    } else if (errors.length === 1) {
      throw errors[0];
    } else {
      throw Object.assign(
        new Error("Multiple errors while releasing resources"),
        {
          code: 'MultipleCleanupErrors',
          errors,
        }
      );
    }
  }
}
