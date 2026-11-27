// Recreates the test database from scratch and runs every migration, so each test run
// proves the migrations work on an empty database.
import pg from 'pg';
import { migrate } from '../../db/migrate.js';
import { ADMIN_URL, TEST_DB, TEST_URL } from '../helpers.js';

export default async function setup() {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`drop database if exists ${TEST_DB} with (force)`);
  await admin.query(`create database ${TEST_DB}`);
  await admin.end();
  await migrate(TEST_URL);
}
