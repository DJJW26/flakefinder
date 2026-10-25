/** Jest fixture for the flakefinder e2e harness.
 *
 * Emits a JUnit XML report (./junit.xml) that flakefinder ingests after every
 * retry attempt. See flakefinder.config.json for the report glob.
 */
module.exports = {
  reporters: ['default', ['jest-junit', { outputDirectory: '.', outputName: 'junit.xml' }]],
  testEnvironment: 'node',
};
