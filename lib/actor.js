const Step = require('./step');
const { MetaStep } = require('./step');
const container = require('./container');
const { methodsOfObject } = require('./utils');
const recorder = require('./recorder');
const event = require('./event');
const store = require('./store');
const output = require('./output');

/**
 * @interface
 * @alias ActorStatic
 */
class Actor {
  /**
   * Print the comment on log. Also, adding a step in the `Test.steps` object
   * @param {string} msg
   * @param {string} color
   * @inner
   *
   * ⚠️ returns a promise which is synchronized internally by recorder
   */
  async say(msg, color = 'cyan') {
    const step = new Step('say', 'say');
    step.status = 'passed';
    return recordStep(step, [msg]).then(() => {
      // this is backward compatibility as this event may be used somewhere
      event.emit(event.step.comment, msg);
      output.say(msg, `${color}`);
    });
  }

  /**
   * set the maximum execution time for the next step
   * @function
   * @param {number} timeout - step timeout in seconds
   * @return {this}
   * @inner
   */
  limitTime(timeout) {
    if (!store.timeouts) return this;

    event.dispatcher.prependOnceListener(event.step.before, step => {
      output.log(`Timeout to ${step}: ${timeout}s`);
      step.setTimeout(timeout * 1000, Step.TIMEOUT_ORDER.codeLimitTime);
    });

    return this;
  }

  /**
   * @function
   * @param {*} [opts]
   * @return {this}
   * @inner
   */
  retry(opts) {
    if (opts === undefined) opts = 1;
    recorder.retry(opts);
    // remove retry once the step passed
    recorder.add(() => event.dispatcher.once(event.step.finished, () => recorder.retries.pop()));
    return this;
  }
}

/**
 * Fetches all methods from all enabled helpers,
 * and makes them available to use from I. object
 * Wraps helper methods into promises.
 * @ignore
 */
module.exports = function (obj = {}) {
  const actor = container.actor() || new Actor();

  // load all helpers once container initialized
  container.started(() => {
    const translation = container.translation();
    const helpers = container.helpers();

    // add methods from enabled helpers
    Object.values(helpers).forEach(helper => {
      methodsOfObject(helper, 'Helper')
        .filter(method => method !== 'constructor' && method[0] !== '_')
        .forEach(action => {
          const actionAlias = translation.actionAliasFor(action);
          if (!actor[action]) {
            actor[action] = actor[actionAlias] = function () {
              const step = new Step(helper, action);
              if (translation.loaded) {
                step.name = actionAlias;
                step.actor = translation.I;
              }
              // add methods to promise chain
              return recordStep(step, Array.from(arguments));
            };
          }
        });
    });

    // add translated custom steps from actor
    Object.keys(obj).forEach(key => {
      const actionAlias = translation.actionAliasFor(key);
      if (!actor[actionAlias]) {
        actor[actionAlias] = actor[key];
      }
    });

    container.append({
      support: {
        I: actor,
      },
    });
  });
  // store.actor = actor;
  // add custom steps from actor
  Object.keys(obj).forEach(key => {
    const ms = new MetaStep('I', key);
    ms.setContext(actor);
    actor[key] = ms.run.bind(ms, obj[key]);
  });

  return actor;
};

function recordStep(step, args) {
  step.status = 'queued';
  step.setArguments(args);

  // run async before step hooks
  event.emit(event.step.before, step);

  const task = `${step.name}: ${step.humanizeArgs()}`;
  let val;

  // run step inside promise
  recorder.add(
    task,
    () => {
      if (!step.startTime) {
        // step can be retries
        event.emit(event.step.started, step);
        step.startTime = Date.now();
      }
      return (val = step.run(...args));
    },
    false,
    undefined,
    step.getTimeout(),
  );

  event.emit(event.step.after, step);

  recorder.add('step passed', () => {
    step.endTime = Date.now();
    event.emit(event.step.passed, step, val);
    event.emit(event.step.finished, step);
  });

  recorder.catchWithoutStop(err => {
    step.status = 'failed';
    step.endTime = Date.now();
    event.emit(event.step.failed, step);
    event.emit(event.step.finished, step);
    throw err;
  });

  recorder.add('return result', () => val);
  // run async after step hooks

  return recorder.promise();
}
