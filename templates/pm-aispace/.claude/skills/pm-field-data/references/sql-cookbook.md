# 现场实测数据 · SQL 速查

对 `input/converted/<raw 相对目录>/SplittingObject/<文件名>/实测数据.sqlite`。
表结构见镜像目录里的 `_manifest_<文件名>.md`（库在哪由它的 frontmatter `payload:` 给出）。
所有查询都**只取回几十行**，不要 `SELECT *` 扫事实表。

```bash
DB="input/converted/现场数据/SplittingObject/wds_real_data/实测数据.sqlite"
```

## 一、覆盖：这个测点现场有没有数

```sql
-- 按名字找
SELECT 测点ID, 场站名称, 测点名称, 单位, 记录数, 采样间隔秒, "完整率%"
FROM 测点 WHERE 测点名称 LIKE '%坝上水位%' ORDER BY 场站名称;

-- 按场站盘点：这个厂到底接进来哪些量
SELECT 测点类型, count(*) AS 测点数, sum(记录数) AS 总条数
FROM 测点 WHERE 场站名称 LIKE '%棉花滩%' GROUP BY 1 ORDER BY 2 DESC;

-- 按测点类型横比：哪一类量普遍缺
SELECT 测点类型, count(*) 测点数, round(avg("完整率%"),1) 平均完整率
FROM 测点 GROUP BY 1 ORDER BY 3;
```

一批测点在不在（把场景测点清单贴进 IN 里）：

```sql
SELECT 测点ID, 测点名称, 记录数 FROM 测点
WHERE 测点ID IN ('1330300001','1330301100','1330302001');
```

## 二、频率：实际多久来一条

```sql
-- 采样间隔分布（众数口径，台账里也有）
SELECT 采样间隔秒, count(*) FROM 测点 GROUP BY 1 ORDER BY 2 DESC;

-- 某测点的真实间隔分布：是稳定 5 分钟，还是忽快忽慢
SELECT 间隔秒, count(*) 次数 FROM (
  SELECT cast((julianday(时间) - julianday(LAG(时间) OVER (ORDER BY 时间))) * 86400 AS int) 间隔秒
  FROM 实测 WHERE 测点ID = '1330300001')
WHERE 间隔秒 IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 10;
```

## 三、连续性：断流查在哪

```sql
-- 最长的几段空档
SELECT LAG(时间) OVER (ORDER BY 时间) 断前, 时间 断后,
       cast((julianday(时间) - julianday(LAG(时间) OVER (ORDER BY 时间))) * 86400 AS int) 空档秒
FROM 实测 WHERE 测点ID = '1330300001' ORDER BY 空档秒 DESC LIMIT 5;

-- 断在同一天吗：某天全局条数塌陷 = 采集侧问题，不是单个测点问题
SELECT 日期, count(*) 条数, count(DISTINCT 测点ID) 在线测点数
FROM 实测 GROUP BY 1 ORDER BY 1;

-- 完整率最差的测点
SELECT 场站名称, 测点名称, 记录数, 期望条数, "完整率%"
FROM 测点 WHERE "完整率%" <> '' ORDER BY "完整率%" LIMIT 20;
```

## 四、值域：值合不合常识

```sql
-- 恒定不变的测点：常数配置还是采集卡死，要问现场
SELECT 场站名称, 测点名称, 单位, 最小值, 记录数 FROM 测点 WHERE 恒定值 = 1 ORDER BY 场站名称;

-- 负值：流量、出力一般不该为负
SELECT 场站名称, 测点名称, 单位, 最小值, 最大值 FROM 测点
WHERE 最小值 <> '' AND 最小值 < 0 AND 单位 IN ('m³/s','MW');

-- 某测点的跳变：相邻两点变化最大的几次
SELECT * FROM (
  SELECT 时间, 数值, 数值 - LAG(数值) OVER (ORDER BY 时间) AS 变化
  FROM 实测 WHERE 测点ID = '1330300001')
WHERE 变化 IS NOT NULL ORDER BY abs(变化) DESC LIMIT 5;

-- 日极值走势（看趋势别扫事实表）
SELECT 日期, 条数, 最小值, 最大值, 平均值 FROM v_日统计
WHERE 测点ID = '1330300001' ORDER BY 日期;
```

## 五、一致性：几个测点对不对得上

```sql
-- 全厂出力 vs 机组出力之和（同一时刻不一定严格对齐，先按日均值比）
SELECT d.日期,
       max(CASE WHEN 测点名称 LIKE '%全厂出力%' THEN 平均值 END) 全厂,
       sum(CASE WHEN 测点名称 LIKE '%机组出力%' THEN 平均值 END) 机组合计
FROM v_日统计 d WHERE 场站名称 LIKE '%棉花滩%' GROUP BY 1 ORDER BY 1;

-- 同一时刻两个测点并排看
SELECT a.时间, a.数值 水位, b.数值 出力
FROM 实测 a JOIN 实测 b ON a.时间 = b.时间
WHERE a.测点ID = '1330300001' AND b.测点ID = '1330302001'
ORDER BY a.时间 LIMIT 50;
```

## 六、状态码

```sql
-- 全局分布：取值含义要问现场，不要自己解释
SELECT 状态码, count(*) FROM 实测 GROUP BY 1 ORDER BY 2 DESC;

-- 哪些测点集中出现非主状态
SELECT 场站名称, 测点名称, 状态码分布 FROM 测点
WHERE 状态码分布 LIKE '%|%' ORDER BY 场站名称 LIMIT 30;
```

## 七、日指标（太极 t02_product_day）

```bash
DB="input/converted/现场数据/SplittingObject/t02_product_day/日指标.sqlite"
```

粒度是（组织 × 机组 × 指标 × 日）。查厂站日值时加上 `机组编码 = '-1'`（含义待现场确认）。

```sql
-- 某厂站厂级日发电量
SELECT 日期, 组织简称, 数值 FROM v_日指标
WHERE 指标编码='DL01001' AND 机组编码='-1' AND 组织简称 LIKE '%棉花滩%'
ORDER BY 日期;

-- 某个指标各厂覆盖
SELECT 组织简称, 机组编码, 记录数, "完整率%", 空值数, 最小值, 最大值
FROM 覆盖 WHERE 指标编码='DL01001' ORDER BY 组织简称;

-- 定义在、值不在：全程空值的指标
SELECT 指标编码, 指标全称, sum(记录数) 行数, sum(空值数) 空值
FROM 覆盖 GROUP BY 1,2 HAVING sum(空值数)=sum(记录数) ORDER BY 1;

-- 组织表有但本次导出没有
SELECT 组织编码, 组织简称, 层级, 已删除 FROM 组织
WHERE 组织编码 NOT IN (SELECT DISTINCT 组织编码 FROM 日指标);

-- 某日各厂发电量横比
SELECT 组织简称, 数值 FROM v_日指标
WHERE 指标编码='DL01001' AND 机组编码='-1' AND 日期='2025-08-01'
ORDER BY 数值 DESC;
```

## 输出给人看

```bash
sqlite3 -header -column "$DB" "SELECT ...;"     # 终端对齐，粘进文档也能读
sqlite3 -header -csv    "$DB" "SELECT ...;" > output/analysis/xxx.csv
```
