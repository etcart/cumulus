'use strict';

const asyncOperations = require('@cumulus/async-operations');
const { models } = require('@cumulus/api');
const Logger = require('@cumulus/logger');

const logger = new Logger({ sender: '@cumulus/postgres-migration-async-operation' });
exports.handler = async () => {
  const stackName = process.env.stackName;
  const systemBucket = process.env.system_bucket;
  const tableName = process.env.AsyncOperationsTable;

  logger.info('Starting Postgres Migration Async Operation');
  logger.info(stackName);
  logger.info(systemBucket);
  logger.info(tableName);
  logger.info(process.env.MigrationAsyncOperationLambda);
  logger.info(process.env.EcsCluster);
  logger.info(process.env.AsyncOperationTaskDefinition);

  const asyncOperation = await asyncOperations.startAsyncOperation({
    cluster: process.env.EcsCluster,
    lambdaName: process.env.MigrationAsyncOperationLambda,
    asyncOperationTaskDefinition: process.env.AsyncOperationTaskDefinition,
    description: 'Data Migration 2 Lambda ECS Run',
    operationType: 'Migration Count Report',
    payload: {
    },
    stackName,
    systemBucket,
    dynamoTableName: tableName,
    knexConfig: process.env,
    useLambdaEnvironmentVariables: true,
  }, models.AsyncOperation);

  logger.info('completed Postgres Migration Async Operation');
  return asyncOperation;
};
