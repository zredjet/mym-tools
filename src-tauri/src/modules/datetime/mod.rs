use crate::module::ModuleBackend;

pub struct DateTimeModule;
impl ModuleBackend for DateTimeModule {
    fn id(&self) -> &'static str {
        "datetime"
    }
    fn is_stateless(&self) -> bool {
        true
    }
}
