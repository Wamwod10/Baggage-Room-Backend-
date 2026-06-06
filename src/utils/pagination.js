const getPagination = (query = {}) => {
  const page = Math.max(Number(query.page || 1), 1);
  const limit = Math.min(Math.max(Number(query.limit || 50), 1), 200);
  return { page, limit, skip: (page - 1) * limit };
};

const paginated = async (model, { where, include, orderBy, query, select }) => {
  const { page, limit, skip } = getPagination(query);
  const [items, total] = await Promise.all([
    model.findMany({ where, include, select, orderBy, skip, take: limit }),
    model.count({ where }),
  ]);

  return {
    items,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  };
};

module.exports = { getPagination, paginated };
