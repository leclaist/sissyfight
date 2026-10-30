-- local dev only: a separate database for the integration tests
CREATE DATABASE IF NOT EXISTS sissyfight_test CHARACTER SET utf8mb4;
GRANT ALL PRIVILEGES ON sissyfight_test.* TO 'sissyfight'@'%';
