--
-- SiSSYFiGHT schema (MySQL 8). Safe to run repeatedly: `npm run db:setup`.
-- The sessions table is created automatically by express-mysql-session.
--

--
-- Table structure for table `Users`
--

CREATE TABLE IF NOT EXISTS `Users` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `nickname` varchar(13) NOT NULL DEFAULT '',
  `password` varchar(60) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL,
  `avatar` text NOT NULL,
  `lastPlayed` datetime DEFAULT NULL,
  `email` varchar(255) NOT NULL DEFAULT '',
  `createdAt` datetime NOT NULL,
  `updatedAt` datetime NOT NULL,
  `pwResetSent` datetime DEFAULT NULL,
  `pwResetCode` varchar(60) DEFAULT NULL,
  `level` int(11) DEFAULT NULL,
  `month_points` int(11) NOT NULL DEFAULT '0',
  `month_games` int(11) NOT NULL DEFAULT '0',
  `month_wins` int(11) NOT NULL DEFAULT '0',
  `month_wins_solo` int(11) NOT NULL DEFAULT '0',
  `alltime_points` int(11) NOT NULL DEFAULT '0',
  `alltime_games` int(11) NOT NULL DEFAULT '0',
  `alltime_wins` int(11) NOT NULL DEFAULT '0',
  `alltime_wins_solo` int(11) NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`),
  UNIQUE KEY `nickname` (`nickname`),
  KEY `email` (`email`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


--
-- Table structure for table `MonthlyScores`
--

CREATE TABLE IF NOT EXISTS `MonthlyScores` (
  `id` int(11) NOT NULL,
  `record_month` char(7) NOT NULL DEFAULT '',
  `month_points` int(11) NOT NULL DEFAULT '0',
  `month_games` int(11) NOT NULL DEFAULT '0',
  `month_wins` int(11) NOT NULL DEFAULT '0',
  `month_wins_solo` int(11) NOT NULL DEFAULT '0',
  `month_points_rank` int(11) NOT NULL DEFAULT '0',
  `month_win_pct` float NOT NULL DEFAULT '0',
  `month_win_pct_rank` int(11) DEFAULT NULL,
  `month_fame_points` int(11) NOT NULL DEFAULT '0',
  -- one record per user per month, so a repeated rollover can't double-count
  UNIQUE KEY `id_month` (`id`,`record_month`),
  KEY `record_month` (`record_month`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


--
-- Table structure for table `Texts`
--

CREATE TABLE IF NOT EXISTS `Texts` (
  `key` varchar(60) NOT NULL DEFAULT '',
  `text` text NOT NULL,
  `cache_ttl` int(11) DEFAULT NULL,
  PRIMARY KEY (`key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


--
-- Default texts (edit these rows in the database to customize; setup won't overwrite them)
--

INSERT IGNORE INTO `Texts` (`key`, `text`) VALUES
('homepage-news', ''),
('pwreset-email-from', 'SiSSYFiGHT <noreply@example.com>'),
('pwreset-email-subject', 'Reset your SiSSYFiGHT password'),
('pwreset-email-text', 'Hi {nickname},\n\nSomeone (hopefully you) asked to reset your SiSSYFiGHT password. To choose a new one, visit:\n\n{baseUrl}/reset/{code}\n\nThis link works for 24 hours. If you didn''t ask for this, you can ignore this email.\n');
